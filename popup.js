const fields = {
  supplier: document.querySelector("#supplier"),
  item: document.querySelector("#item"),
  date: document.querySelector("#date"),
  amount: document.querySelector("#amount"),
  businessNumber: document.querySelector("#businessNumber"),
  orientation: document.querySelector("#orientation")
};

const scanButton = document.querySelector("#scanButton");
const fillButton = document.querySelector("#fillButton");
const saveButton = document.querySelector("#saveButton");
const filenamePreview = document.querySelector("#filenamePreview");
const statusElement = document.querySelector("#status");
const invoiceStageElements = [...document.querySelectorAll(".invoice-stage")];

function setStage() {
  // 사업자번호 자동입력은 보조 기능이다. 인증 결과와 관계없이 모든 기능을 표시한다.
  for (const element of invoiceStageElements) element.hidden = false;
}

function setStatus(message, type = "") {
  statusElement.textContent = message;
  statusElement.className = `status ${type}`.trim();
}

function sanitize(value, fallback) {
  const cleaned = String(value || "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 60);
}

function dateDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : "";
}

function filenameDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length >= 8) return digits.slice(2, 8);
  return digits.length === 6 ? digits : "";
}

function formattedAmount(value) {
  const number = Number(String(value || "").replace(/\D/g, ""));
  return number ? `${number.toLocaleString("ko-KR")}원` : "";
}

function currentData() {
  return {
    supplier: fields.supplier.value.trim(),
    item: fields.item.value.trim(),
    date: dateDigits(fields.date.value),
    amount: fields.amount.dataset.raw || ""
  };
}

function refreshPreview() {
  const data = currentData();
  const complete = data.supplier && data.item;
  const details = [
    filenameDate(data.date),
    sanitize(data.supplier, "업체명미확인"),
    sanitize(data.item, "품명미확인")
  ].filter(Boolean);
  filenamePreview.textContent = `세금계산서(${details.join("_")}).pdf`;
  saveButton.disabled = !complete;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("현재 탭을 찾지 못했습니다.");
  return tab;
}

function outputSiteFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/(^|\.)smileedi\.com$/.test(host)) return "smileedi";
    if (/(^|\.)ecount\.com$/.test(host)) return "ecount";
    if (/(^|\.)smartbill\.co\.kr$/.test(host)) return "smartbill";
  } catch (_) {
    // URL을 읽지 못하면 기존 generic 흐름을 사용합니다.
  }
  return "generic";
}

function ecountPrintSettingsOpenInPage() {
  if (!/(^|\.)ecount\.com$/i.test(location.hostname)) return false;
  return [...document.querySelectorAll("body *")].some((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return false;
    const value = String(element.innerText || "").replace(/\s+/g, " ");
    return /페이지\s*설정/.test(value) && ["용지종류", "인쇄정렬", "인쇄방향", "여백", "확인", "닫기"]
      .filter((token) => value.includes(token)).length >= 3;
  });
}

function chooseBestFrame(results) {
  return results
    .map((entry) => entry.result)
    .filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
}

async function scanPage(options = {}) {
  const quiet = options?.quiet === true;
  scanButton.disabled = true;
  if (!quiet) setStatus("현재 페이지에서 세금계산서 정보를 읽고 있습니다.");

  try {
    const tab = await activeTab();
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["site-adapters.js", "extractor.js"]
      });
    } catch (error) {
      const message = String(error?.message || error || "");
      if (!/Cannot access contents of the page|request permission to access the respective host/i.test(message)) {
        throw error;
      }
      console.warn("[Hakdol] all-frame scan blocked; retrying top frame");
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["site-adapters.js", "extractor.js"]
      });
    }
    const data = chooseBestFrame(results);

    if (!data) throw new Error("페이지 정보를 읽지 못했습니다.");

    fields.supplier.value = data.supplier || "";
    fields.item.value = data.item || "";
    fields.date.value = data.date || "";
    fields.amount.value = formattedAmount(data.amount);
    fields.amount.dataset.raw = data.amount || "";
    refreshPreview();

    const missing = [
      !data.supplier && "업체명",
      !data.item && "품명"
    ].filter(Boolean);

    if (missing.length) {
      if (!quiet) setStatus(`${missing.join("·")}은 읽지 못했습니다. 빈칸만 직접 입력해주세요.`);
      return false;
    } else if (!data.date) {
      setStatus("작성일을 읽지 못했습니다. 날짜를 빼고 저장할 수 있습니다.");
    } else {
      setStatus("정보를 읽었습니다. 파일명을 확인한 뒤 저장해주세요.", "success");
    }
    return true;
  } catch (error) {
    if (!quiet) setStatus(error?.message || "페이지 정보를 읽지 못했습니다.", "error");
    return false;
  } finally {
    scanButton.disabled = false;
  }
}

async function completeAccessGateInPage(rawNumber, shouldSubmit) {
  const number = String(rawNumber || "").replace(/\D/g, "");
  const formatted = number.length === 10
    ? `${number.slice(0, 3)}-${number.slice(3, 5)}-${number.slice(5)}`
    : number;
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const bodyText = normalize(document.body?.innerText || "");
  const invoiceOpen = /공급받는\s*자/.test(bodyText) && /공급\s*가액|합계금액/.test(bodyText) && /품\s*(?:목|명)/.test(bodyText);
  if (invoiceOpen) return { matched: false, ok: false, invoiceOpen: true };

  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const visibleInputs = [...document.querySelectorAll("input:not([type=hidden]):not([disabled]):not([readonly])")]
    .filter((input) => /^(text|tel|number|password)$/.test(input.type) && visible(input));

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    if (typeof input.blur === "function") input.blur();
    else input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function exactConfirmButton(container) {
    const roots = [container, container?.closest?.("form")].filter(Boolean);
    for (const root of roots) {
      const buttons = [...root.querySelectorAll("button, input[type=button], input[type=submit], a, [role=button]")]
        .filter((button) => {
          const label = normalize(button.innerText || button.value || button.title || button.getAttribute?.("aria-label") || "");
          return visible(button) && /^확인$/i.test(label);
        });
      if (buttons.length === 1) return buttons[0];
    }
    return null;
  }

  // 사업자번호가 3칸(3-2-5)으로 나뉜 페이지를 우선 탐색한다.
  // '사업자번호'가 적힌 가장 작은 영역을 선택해 주민등록번호 입력칸과 섞이지 않게 한다.
  const splitContainers = [...document.querySelectorAll("form, fieldset, section, article, td, div")]
    .map((container) => {
      const context = normalize(container.innerText || "");
      if (!/사업자\s*(?:등록)?\s*번호/.test(context)) return null;
      if (context.length > 1200) return null;
      const inputs = visibleInputs.filter((input) => container.contains(input));
      if (inputs.length < 3) return null;
      let best = null;
      for (let index = 0; index <= inputs.length - 3; index += 1) {
        const triple = inputs.slice(index, index + 3);
        const lengths = triple.map((input) => Number(input.maxLength || 0));
        let score = 0;
        if (lengths[0] === 3 && lengths[1] === 2 && lengths[2] === 5) score += 20;
        if (inputs.length === 3) score += 6;
        if (/사업자\s*(?:등록)?\s*번호\s*확인/.test(context)) score += 8;
        if (/주민\s*등록\s*번호/.test(context)) score -= 4;
        const placeholders = triple.map((input) => normalize(input.placeholder || "").replace(/\D/g, "").length);
        if (placeholders[0] === 3 && placeholders[1] === 2 && placeholders[2] === 5) score += 8;
        if (!best || score > best.score) best = { triple, score };
      }
      if (!best || best.score < 8) return null;
      return { container, inputs: best.triple, score: best.score, textLength: context.length };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.textLength - b.textLength);

  const split = splitContainers[0];
  if (split) {
    if (number.length !== 10) return { matched: true, ok: false, needsNumber: true, split: true };
    const parts = [number.slice(0, 3), number.slice(3, 5), number.slice(5)];
    split.inputs.forEach((input, index) => setNativeValue(input, parts[index]));
    const applied = split.inputs.map((input) => String(input.value || "").replace(/\D/g, "")).join("");
    if (applied !== number) {
      return { matched: true, ok: false, filled: false, clicked: false, split: true, reason: "value_not_applied" };
    }
    if (!shouldSubmit) return { matched: true, ok: true, filled: true, clicked: false, split: true };
    const submit = exactConfirmButton(split.container);
    if (!submit) return { matched: true, ok: true, filled: true, clicked: false, split: true, reason: "button_not_found" };
    await new Promise((resolve) => setTimeout(resolve, 120));
    const stillApplied = split.inputs.map((input) => String(input.value || "").replace(/\D/g, "")).join("");
    if (stillApplied !== number) {
      return { matched: true, ok: false, filled: false, clicked: false, split: true, reason: "value_reverted" };
    }
    submit.click();
    return { matched: true, ok: true, filled: true, clicked: true, split: true };
  }

  const keywords = /사업자|등록번호|business|biz|corp|company/i;
  const gateDetected = visibleInputs.length > 0 && /보안메일|암호화된\s*메일|사업자\s*(?:\(\s*주민\s*\))?\s*(?:등록)?\s*번호.{0,60}(?:입력|기입)|사업자\s*등록번호\s*10자리|메일.*비밀번호/i.test(bodyText);
  if (!gateDetected) return { matched: false, ok: false };
  const candidates = visibleInputs
    .map((input) => {
      const label = input.labels ? [...input.labels].map((item) => item.innerText).join(" ") : "";
      const nearby = String(input.closest("form, section, article, div")?.innerText || "").slice(0, 500);
      const context = `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") || ""} ${label} ${nearby}`;
      let score = keywords.test(context) ? 5 : 0;
      if (input.maxLength === 10 || input.maxLength === 12 || input.maxLength === 13) score += 3;
      if (/tel|text|number|password/.test(input.type)) score += 1;
      if (visibleInputs.length === 1) score += 6;
      return { input, score };
    })
    .filter((entry) => entry.score >= 5)
    .sort((a, b) => b.score - a.score);

  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    return { matched: true, ok: false, reason: "ambiguous_input" };
  }
  const target = candidates[0]?.input;
  if (!target) return { matched: true, ok: false, reason: "input_not_found" };
  if (number.length !== 10) return { matched: true, ok: false, needsNumber: true };

  const isSmileEdi = /(^|\.)smileedi\.com$/i.test(location.hostname);
  const digitsOnly = isSmileEdi || /사업자\s*\(\s*주민\s*\)|없이\s*입력|하이픈.*없이/.test(bodyText);
  const useFormatted = !digitsOnly && (target.maxLength === 12 || /-/.test(target.placeholder || ""));
  const value = useFormatted ? formatted : number;
  setNativeValue(target, value);

  if (String(target.value || "").replace(/\D/g, "") !== number) {
    return { matched: true, ok: false, filled: false, clicked: false, reason: "value_not_applied" };
  }

  if (!shouldSubmit) return { matched: true, ok: true, filled: true, clicked: false };

  const form = target.closest("form");
  const buttons = [...new Set([
    ...(form ? form.querySelectorAll("button, input[type=button], input[type=submit], a, [role=button]") : []),
    ...document.querySelectorAll("button, input[type=button], input[type=submit], a, [role=button]")
  ])];
  const exactButtons = buttons.filter((button) => {
    const buttonText = normalize(button.innerText || button.value || button.title || button.getAttribute("aria-label") || "");
    return visible(button) && /^확인$/i.test(buttonText);
  });
  const formButtons = form ? exactButtons.filter((button) => form.contains(button)) : [];
  const submit = formButtons.length === 1 ? formButtons[0] : exactButtons.length === 1 ? exactButtons[0] : null;
  if (!submit) return { matched: true, ok: true, filled: true, clicked: false, reason: "button_not_found" };

  await new Promise((resolve) => setTimeout(resolve, 120));
  if (String(target.value || "").replace(/\D/g, "") !== number) {
    return { matched: true, ok: false, filled: false, clicked: false, reason: "value_reverted" };
  }
  submit.click();
  return { matched: true, ok: true, filled: true, clicked: true };
}
async function runAccessGate(number, shouldSubmit = true) {
  const tab = await activeTab();
  const probes = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: completeAccessGateInPage,
    args: [number, false]
  });
  const candidate = probes.find((entry) => entry.result?.matched);
  if (!shouldSubmit || !candidate?.result?.filled) return probes;
  return chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [candidate.frameId] },
    func: completeAccessGateInPage,
    args: [number, true]
  });
}

async function fillBusinessNumber() {
  const digits = fields.businessNumber.value.replace(/\D/g, "");
  if (digits.length !== 10) {
    setStatus("사업자번호 10자리를 확인해주세요.", "error");
    return;
  }

  fields.businessNumber.value = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  await chrome.storage.local.set({ businessNumber: fields.businessNumber.value });

  try {
    const results = await runAccessGate(digits, true);
    const matched = results.find((entry) => entry.result?.matched)?.result;
    if (matched?.clicked) {
      setStatus("사업자번호를 자동 입력하고 확인을 눌렀습니다. 세금계산서가 열리는 중입니다.", "success");
    } else if (matched?.filled) {
      setStatus("사업자번호는 입력했습니다. 이 사이트의 확인 버튼은 직접 눌러주세요.", "success");
    } else {
      setStatus("자동 입력하지 못했습니다. 사이트에서 직접 입력한 뒤 다시 읽기를 눌러주세요.");
    }
  } catch (error) {
    setStatus(error?.message || "사업자번호를 입력하지 못했습니다.", "error");
  }
}

async function autoHandleAccessGate() {
  const digits = fields.businessNumber.value.replace(/\D/g, "");
  try {
    const results = await runAccessGate(digits, true);
    const gate = results.find((entry) => entry.result?.matched)?.result;
    if (!gate) {
      return "none";
    }

    if (gate.needsNumber || digits.length !== 10) {
      setStatus("처음 한 번만 학교 사업자번호를 저장해주세요. 다음부터는 자동 입력하고 확인까지 누릅니다.");
      return "failed";
    }
    if (gate.clicked) {
      setStatus("사업자번호를 자동 입력하고 확인을 눌렀습니다. 세금계산서가 열리는 중입니다.", "success");
      return "clicked";
    }
    if (gate.filled) {
      setStatus("사업자번호를 자동 입력했습니다. 확인 버튼만 직접 눌러주세요.", "success");
      return "filled";
    }

    setStatus("자동 입력하지 못했습니다. 사이트에서 직접 입력한 뒤 다시 읽기를 눌러주세요.");
    return "failed";
  } catch (_) {
    // 인증 감지 실패는 분석을 막지 않는다. 기존 정보 읽기를 그대로 진행한다.
    return "none";
  }
}

async function savePdf(options = {}) {
  const data = currentData();
  if (!data.supplier || !data.item) {
    setStatus("업체명·품명을 확인해주세요.", "error");
    return false;
  }

  const triggerButton = options.triggerButton || saveButton;
  const originalLabel = triggerButton.textContent;
  triggerButton.disabled = true;
  triggerButton.textContent = "PDF 만드는 중…";

  try {
    const tab = await activeTab();
    const site = outputSiteFromUrl(tab.url);
    if (site === "smileedi") {
      setStatus("세금계산서 인쇄 화면을 준비하고 있습니다.");
    } else if (site === "smartbill") {
      setStatus("스마트빌 인쇄 화면을 준비하고 있습니다.");
    } else if (site === "ecount") {
      let settingsOpen = false;
      try {
        const probes = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: ecountPrintSettingsOpenInPage
        });
        settingsOpen = probes.some((entry) => entry.result === true);
      } catch (_) {
        // 감지 실패는 저장을 막지 않습니다.
      }
      setStatus(settingsOpen
        ? "인쇄 설정창이 열렸습니다. 계산서를 가리지 않도록 제외하고 PDF를 만듭니다."
        : "PDF를 만들고 있습니다. 잠시만 기다려주세요.");
    } else {
      setStatus("PDF를 만들고 있습니다. 잠시만 기다려주세요.");
    }
    const response = await chrome.runtime.sendMessage({
      type: "SAVE_TAX_INVOICE_PDF",
      tabId: tab.id,
      data,
      orientation: "portrait"
    });

    if (!response?.ok) throw new Error(response?.error || "PDF 저장에 실패했습니다.");
    setStatus(`${response.filename} PDF 저장을 시작했습니다.`, "success");
    return true;
  } catch (error) {
    setStatus(error?.message || "PDF 저장에 실패했습니다.", "error");
    return false;
  } finally {
    triggerButton.textContent = originalLabel;
    refreshPreview();
  }
}

for (const input of [fields.supplier, fields.item, fields.date]) {
  input.addEventListener("input", refreshPreview);
}

fields.businessNumber.addEventListener("input", () => {
  const digits = fields.businessNumber.value.replace(/\D/g, "").slice(0, 10);
  if (digits.length > 5) fields.businessNumber.value = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  else if (digits.length > 3) fields.businessNumber.value = `${digits.slice(0, 3)}-${digits.slice(3)}`;
  else fields.businessNumber.value = digits;
});


scanButton.addEventListener("click", scanPage);
fillButton.addEventListener("click", fillBusinessNumber);
saveButton.addEventListener("click", () => savePdf());

(async () => {
  const settings = await chrome.storage.local.get(["businessNumber"]);
  fields.businessNumber.value = settings.businessNumber || "";
  fields.orientation.value = "portrait";
  setStage("invoice");
  refreshPreview();
  const authResult = await autoHandleAccessGate();
  if (authResult === "none") {
    await scanPage();
  } else if (authResult === "clicked") {
    let read = false;
    for (const delay of [700, 1300]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (await scanPage({ quiet: true })) {
        read = true;
        break;
      }
    }
    if (!read) setStatus("계산서가 열리면 다시 읽기를 눌러주세요. 다른 기능도 계속 사용할 수 있습니다.");
  }
})();
