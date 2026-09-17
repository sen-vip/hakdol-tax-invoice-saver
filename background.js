importScripts("pdf-utils.js");

const DEBUGGER_VERSION = "1.3";
const PENDING_RENAME_KEY = "pendingTaxInvoiceRename";
const PENDING_SITE_RENAME_KEY = "pendingSiteDownloadRename";
const SITE_RENAME_TTL_MS = 15_000;
const SITE_DOWNLOAD_RENAME_ENABLED = new Set(["smileedi", "ecount"]);
const busyTabs = new Set();

function siteFromHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (/(^|\.)smileedi\.com$/.test(host)) return "smileedi";
  if (/(^|\.)ecount\.com$/.test(host)) return "ecount";
  return "";
}

function hostnameFromDownloadUrl(value) {
  try {
    const parsed = new URL(value || "");
    if (parsed.hostname) return parsed.hostname.toLowerCase();
    if (parsed.origin && parsed.origin !== "null") return new URL(parsed.origin).hostname.toLowerCase();
  } catch (_) {
    // 다운로드 URL이 없거나 data URL이면 사이트 비교에서 제외합니다.
  }
  return "";
}

function isPdfDownload(downloadItem) {
  const mime = String(downloadItem?.mime || "").toLowerCase();
  const values = [downloadItem?.filename, downloadItem?.url, downloadItem?.finalUrl]
    .map((value) => String(value || "").toLowerCase());
  return mime === "application/pdf" || mime.startsWith("application/pdf;") ||
    values.some((value) => /\.pdf(?:$|[?#])/.test(value)) ||
    values.some((value) => value.startsWith("data:application/pdf"));
}

function matchesSitePendingRename(downloadItem, pending, extensionId, now = Date.now()) {
  if (!pending || !SITE_DOWNLOAD_RENAME_ENABLED.has(pending.site)) return false;
  if (!pending.filename || !Number.isInteger(pending.tabId) || now > pending.expiresAt) return false;
  if (!isPdfDownload(downloadItem)) return false;

  // 확장앱이 직접 만든 PDF는 일반 pending rename이 담당합니다.
  // 사이트 다운로드용 pending이 이를 가로채면 이전 파일명이 덮어써질 수 있습니다.
  if (downloadItem.byExtensionId) return false;

  const downloadSites = [downloadItem.referrer, downloadItem.url, downloadItem.finalUrl]
    .map(hostnameFromDownloadUrl)
    .map(siteFromHostname)
    .filter(Boolean);
  return downloadSites.includes(pending.site);
}

async function clearExpiredSiteRename(requestId) {
  const stored = await chrome.storage.session.get(PENDING_SITE_RENAME_KEY);
  const pending = stored[PENDING_SITE_RENAME_KEY];
  if (!pending || pending.requestId !== requestId || Date.now() < pending.expiresAt) return;
  await chrome.storage.session.remove(PENDING_SITE_RENAME_KEY);
}

function safeFilenamePart(value, fallback) {
  const cleaned = String(value || "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  return (cleaned || fallback).slice(0, 60);
}

function normalizeDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length >= 8) return digits.slice(2, 8);
  if (digits.length === 6) return digits;
  return "";
}

function buildFilename(data) {
  const supplier = safeFilenamePart(data.supplier, "업체명미확인");
  const item = safeFilenamePart(data.item, "품명미확인");
  const date = normalizeDate(data.date);
  const details = [date, supplier, item].filter(Boolean).join("_");
  return `세금계산서(${details}).pdf`;
}

async function detachQuietly(target) {
  try {
    await chrome.debugger.detach(target);
  } catch (_) {
    // 이미 분리된 경우에는 별도 조치가 필요하지 않습니다.
  }
}

async function pageCall(tabId, method, arg = null) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["print-adapters.js"]
  });
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (name, value) => globalThis.HakdolPrint[name](value),
    args: [method, arg]
  });
}

function preferredFrame(results, predicate) {
  return (results || []).find((entry) => predicate(entry.result));
}

async function waitForTabComplete(tabId, timeoutMs = 8_000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function verifiedPrintTab(tabId, adapter) {
  if (!["smileedi", "smartbill"].includes(adapter)) return null;
  const candidates = await pageCall(tabId, "safePrintUrl", adapter);
  const verified = preferredFrame(candidates, (result) => Boolean(result?.url));
  if (!verified) return null;
  let printTab;
  try {
    printTab = await chrome.tabs.create({ url: verified.result.url, active: false });
    await waitForTabComplete(printTab.id);
    return { tabId: printTab.id, source: verified.result.source };
  } catch (_) {
    if (printTab?.id !== undefined) await chrome.tabs.remove(printTab.id).catch(() => {});
    return null;
  }
}

async function printCurrentTabToPdf(tabId, filename, orientation) {
  if (busyTabs.has(tabId)) throw new Error("이미 PDF를 만들고 있습니다.");
  busyTabs.add(tabId);
  let outputTabId = tabId;
  let temporaryTabId = null;
  let target = { tabId };
  let attached = false;
  let adapter = "generic";
  let strategy = "generic_print";
  let ecountHidden = null;

  try {
    let states = [];
    try {
      states = await pageCall(tabId, "inspect");
    } catch (_) {
      console.info("[Hakdol PDF] site adapter unavailable; generic fallback");
    }
    const siteState = preferredFrame(states, (result) => result?.adapter && result.adapter !== "generic")?.result;
    adapter = siteState?.adapter || "generic";
    console.info("[Hakdol PDF] adapter:", adapter);

    if (adapter === "smileedi" || adapter === "smartbill") {
      const verified = await verifiedPrintTab(tabId, adapter);
      if (verified) {
        temporaryTabId = verified.tabId;
        outputTabId = temporaryTabId;
        target = { tabId: outputTabId };
        strategy = `${adapter}_site_print`;
        console.info("[Hakdol PDF] verified site print document detected");
      }
    }

    if (!temporaryTabId && adapter === "ecount") {
      const prepared = await pageCall(tabId, "prepareEcount");
      const applied = preferredFrame(prepared, (result) => result?.applied || result?.modalDetected);
      ecountHidden = applied?.result || null;
      strategy = "ecount_clean_print";
      if (ecountHidden?.modalDetected) console.info("[Hakdol PDF] print settings modal detected");
    } else if (!temporaryTabId && adapter === "hometax") {
      await pageCall(tabId, "prepareHometax");
      strategy = "hometax_clean_print";
    } else if (!temporaryTabId && adapter === "smartbill") {
      const prepared = await pageCall(tabId, "prepareInvoiceOnly", "smartbill");
      if (preferredFrame(prepared, (result) => result?.applied)) {
        strategy = "smartbill_invoice_only";
      } else {
        strategy = "smartbill_generic_fallback";
        console.info("[Hakdol PDF] invoice-only area not found; generic fallback");
      }
    }

    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");

    const printOptions = {
      displayHeaderFooter: false,
      printBackground: true,
      preferCSSPageSize: true,
      scale: 0.95
    };

    if (orientation === "landscape") printOptions.landscape = true;
    if (orientation === "portrait") printOptions.landscape = false;

    let data;
    if (temporaryTabId !== null) {
      try {
        const result = await chrome.debugger.sendCommand(target, "Page.printToPDF", printOptions);
        data = result?.data;
        validatePdf(data, true);
      } catch (_) {
        console.info("[Hakdol PDF] verified site print failed; using site fallback");
        if (attached) await detachQuietly(target);
        attached = false;
        outputTabId = tabId;
        target = { tabId };
        if (adapter === "smartbill") {
          const prepared = await pageCall(tabId, "prepareInvoiceOnly", "smartbill");
          strategy = preferredFrame(prepared, (result) => result?.applied)
            ? "smartbill_invoice_only_fallback"
            : "smartbill_generic_fallback";
        } else {
          strategy = "smileedi_invoice_capture_fallback";
        }
        await chrome.debugger.attach(target, DEBUGGER_VERSION);
        attached = true;
        await chrome.debugger.sendCommand(target, "Page.enable");
      }
    }

    if (!data && adapter === "smileedi" && outputTabId === tabId) {
      const regions = await pageCall(tabId, "invoiceRegion");
      const region = preferredFrame(regions, (result) => result && result.width >= 350)?.result;
      if (region) {
        console.info("[Hakdol PDF] SmileEDI invoice capture fallback");
        const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
          format: "jpeg",
          quality: 95,
          captureBeyondViewport: true,
          clip: region
        });
        data = await screenshotPdf(shot?.data, orientation);
        if (!strategy.includes("fallback")) strategy = "smileedi_invoice_capture";
      } else {
        console.info("[Hakdol PDF] SmileEDI invoice region not found; validated print fallback");
        const result = await chrome.debugger.sendCommand(target, "Page.printToPDF", printOptions);
        data = result?.data;
        strategy = "smileedi_validated_fallback";
      }
    } else if (!data) {
      const result = await chrome.debugger.sendCommand(target, "Page.printToPDF", printOptions);
      data = result?.data;
    }

    validatePdf(data, ["smileedi", "ecount", "smartbill"].includes(adapter));

    await detachQuietly(target);
    attached = false;

    // 통합 저장은 확장앱이 직접 PDF를 생성합니다.
    // 과거의 사이트 다운로드 rename 상태가 남아 있으면 새 파일명을 덮어쓸 수 있으므로 먼저 제거합니다.
    await chrome.storage.session.remove(PENDING_SITE_RENAME_KEY).catch(() => {});

    // chrome.downloads.onDeterminingFilename에서도 동일한 최신 파일명을 쓰도록
    // 실제 다운로드 직전에 현재 계산된 파일명을 짧게 예약합니다.
    await chrome.storage.local.set({
      [PENDING_RENAME_KEY]: {
        filename,
        expiresAt: Date.now() + 15_000
      }
    });

    let downloadId;
    try {
      downloadId = await chrome.downloads.download({
        url: `data:application/pdf;base64,${data}`,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
    } catch (error) {
      await chrome.storage.local.remove(PENDING_RENAME_KEY).catch(() => {});
      throw error;
    }

    return { downloadId, adapter, strategy, ecountHidden };
  } catch (error) {
    if (attached) await detachQuietly(target);
    throw error;
  } finally {
    await pageCall(tabId, "restore").catch(() => {});
    if (temporaryTabId !== null) {
      await pageCall(temporaryTabId, "restore").catch(() => {});
      await chrome.tabs.remove(temporaryTabId).catch(() => {});
    }
    busyTabs.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ARM_SITE_DOWNLOAD_RENAME") {
    const site = String(message.site || "");
    if (!SITE_DOWNLOAD_RENAME_ENABLED.has(site)) {
      sendResponse({ ok: false, error: "이 사이트는 자동 파일명 적용 대상이 아닙니다." });
      return false;
    }

    const filename = buildFilename(message.data || {});
    const requestId = crypto.randomUUID();
    const createdAt = Date.now();
    chrome.tabs.get(message.tabId)
      .then((tab) => {
        const actualSite = siteFromHostname(new URL(tab.url || "").hostname);
        if (actualSite !== site) throw new Error("현재 탭과 저장 대상 사이트가 일치하지 않습니다.");
        return chrome.storage.session.set({
          [PENDING_SITE_RENAME_KEY]: {
            filename,
            site,
            tabId: message.tabId,
            requestId,
            createdAt,
            expiresAt: createdAt + SITE_RENAME_TTL_MS
          }
        });
      })
      .then(() => {
        setTimeout(() => clearExpiredSiteRename(requestId).catch(() => {}), SITE_RENAME_TTL_MS + 250);
        sendResponse({ ok: true, filename, requestId, expiresAt: createdAt + SITE_RENAME_TTL_MS });
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "CANCEL_SITE_DOWNLOAD_RENAME") {
    chrome.storage.session.get(PENDING_SITE_RENAME_KEY)
      .then((stored) => {
        const pending = stored[PENDING_SITE_RENAME_KEY];
        if (!pending || (message.requestId && pending.requestId !== message.requestId)) return;
        return chrome.storage.session.remove(PENDING_SITE_RENAME_KEY);
      })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "ARM_TAX_INVOICE_RENAME") {
    const filename = buildFilename(message.data || {});
    chrome.storage.local.set({
      [PENDING_RENAME_KEY]: {
        filename,
        expiresAt: Date.now() + 90_000
      }
    }).then(() => sendResponse({ ok: true, filename }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type !== "SAVE_TAX_INVOICE_PDF") return false;

  const filename = buildFilename(message.data || {});
  printCurrentTabToPdf(message.tabId, filename, message.orientation || "auto")
    .then(({ downloadId, adapter, strategy, ecountHidden }) => sendResponse({
      ok: true,
      filename,
      downloadId,
      adapter,
      strategy,
      ecountHidden
    }))
    .catch((error) => {
      const raw = error?.message || String(error);
      let userMessage = raw;

      if (/Another debugger is already attached/i.test(raw)) {
        userMessage = "개발자도구가 열려 있어 PDF 저장을 시작하지 못했습니다. 개발자도구를 닫고 다시 시도해주세요.";
      } else if (/restricted by policy|blocked by policy|enterprise policy/i.test(raw)) {
        userMessage = "학교 PC의 브라우저 보안 정책이 현재 화면 PDF 생성을 제한했습니다. 사이트 PDF 저장 방식을 이용해주세요.";
      } else if (/Cannot access|not allowed|chrome:\/\//i.test(raw)) {
        userMessage = "이 페이지에서는 저장할 수 없습니다. 실제 세금계산서 화면 탭에서 다시 시도해주세요.";
      }

      sendResponse({ ok: false, error: userMessage });
    });

  return true;
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  (async () => {
    // 1순위: 확장앱이 직접 생성한 PDF.
    // 팝업 미리보기/백그라운드에서 방금 계산한 파일명을 그대로 사용합니다.
    const stored = await chrome.storage.local.get(PENDING_RENAME_KEY);
    const pending = stored[PENDING_RENAME_KEY];
    if (pending && Date.now() <= pending.expiresAt && isPdfDownload(downloadItem)) {
      const extensionOwned =
        downloadItem.byExtensionId === chrome.runtime.id ||
        String(downloadItem.url || "").toLowerCase().startsWith("data:application/pdf");

      if (extensionOwned) {
        await chrome.storage.local.remove(PENDING_RENAME_KEY);
        await chrome.storage.session.remove(PENDING_SITE_RENAME_KEY).catch(() => {});
        suggest({ filename: pending.filename, conflictAction: "uniquify" });
        return;
      }
    } else if (pending) {
      await chrome.storage.local.remove(PENDING_RENAME_KEY);
    }

    // 2순위: SmileEDI/eCount 등이 사이트 자체적으로 시작한 PDF 다운로드.
    const siteStored = await chrome.storage.session.get(PENDING_SITE_RENAME_KEY);
    const sitePending = siteStored[PENDING_SITE_RENAME_KEY];
    if (sitePending && Date.now() > sitePending.expiresAt) {
      await chrome.storage.session.remove(PENDING_SITE_RENAME_KEY);
    } else if (matchesSitePendingRename(downloadItem, sitePending, chrome.runtime.id)) {
      await chrome.storage.session.remove(PENDING_SITE_RENAME_KEY);
      suggest({ filename: sitePending.filename, conflictAction: "uniquify" });
      return;
    }

    suggest();
  })().catch(() => suggest());

  return true;
});
