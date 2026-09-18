// PDF 출력 품질만 담당합니다. 메타데이터 추출/파일명 로직과 분리되어 있습니다.
(() => {
  if (globalThis.HakdolPrint) return;

  const RESTORE_KEY = "__hakdolPrintRestoreState";
  const text = (element) => String(element?.innerText || element?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  const visible = (element) => {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };

  function identify(hostname = location.hostname) {
    const host = String(hostname || "").toLowerCase();
    if (/(^|\.)smileedi\.com$/.test(host)) return "smileedi";
    if (/(^|\.)ecount\.com$/.test(host)) return "ecount";
    if (/(^|\.)smartbill\.co\.kr$/.test(host)) return "smartbill";
    if (/(^|\.)hometax\.go\.kr$/.test(host)) return "hometax";
    if (/(^|\.)taxbill365\.com$/.test(host)) return "taxbill365";
    return "generic";
  }

  function invoiceEvidence(value) {
    const source = String(value || "").replace(/\s+/g, " ");
    const tests = [
      /전자\s*(?:세금)?\s*계산서/,
      /승인\s*번호/,
      /공급\s*받는\s*자/,
      /공급\s*자/,
      /등록\s*번호/,
      /작성\s*일자?/,
      /공급\s*가액/,
      /품\s*(?:목|명)/,
      /합계\s*금액/
    ];
    return tests.reduce((score, pattern) => score + Number(pattern.test(source)), 0);
  }

  function junkEvidence(value) {
    const source = String(value || "").replace(/\s+/g, " ");
    const tests = [
      /발행\s*상태/,
      /발행\s*시간/,
      /담당자/,
      /메일\s*주소/,
      /국세청\s*전송/,
      /전송\s*상태/,
      /문서\s*History/i,
      /신용도/,
      /고객\s*센터/,
      /XML\s*다운로드/i,
      /PDF\s*변환/i,
      /발행정보\s*포함\s*인쇄/,
      /현재\s*계산서를?\s*\d+\s*회\s*출력/,
      /광고|호텔|ERP\s*살펴보기/i
    ];
    return tests.reduce((score, pattern) => score + Number(pattern.test(source)), 0);
  }

  function hasInvoiceCore(value) {
    const source = String(value || "").replace(/\s+/g, " ");
    const groups = [
      /공급\s*자/,
      /공급\s*받는\s*자/,
      /품\s*(?:목|명)/,
      /합계\s*금액/,
      /(?:작성\s*일자?|공급\s*가액|승인\s*번호)/
    ];
    return groups.filter((pattern) => pattern.test(source)).length >= 5;
  }

  function findInvoiceElement() {
    const selectors = "table, article, section, main, [role='document'], div";
    const candidates = [...document.querySelectorAll(selectors)]
      .filter(visible)
      .map((element) => {
        const value = text(element);
        const evidence = invoiceEvidence(value);
        const junk = junkEvidence(value);
        const rect = element.getBoundingClientRect();
        const tableBonus = element.tagName === "TABLE" ? 1 : 0;
        const area = Math.max(1, rect.width * rect.height);
        return { element, value, evidence, junk, rect, tableBonus, area };
      })
      .filter((entry) =>
        entry.evidence >= 7 &&
        hasInvoiceCore(entry.value) &&
        entry.rect.width >= 350 &&
        entry.rect.height >= 180
      )
      .sort((a, b) => {
        // "전체 페이지"보다 실제 계산서 표/박스를 우선합니다.
        if (b.tableBonus !== a.tableBonus) return b.tableBonus - a.tableBonus;
        if (a.junk !== b.junk) return a.junk - b.junk;
        // 같은 수준이면 가장 작은 공통 컨테이너를 선택합니다.
        if (a.area !== b.area) return a.area - b.area;
        return b.evidence - a.evidence;
      });
    return candidates[0]?.element || null;
  }

  function record(element, records) {
    if (!element || records.some((entry) => entry.element === element)) return;
    records.push({
      element,
      style: element.getAttribute("style"),
      className: element.getAttribute("class")
    });
  }

  function startRestoreState(kind) {
    restore();
    const state = { kind, records: [], extras: [], timer: 0 };
    globalThis[RESTORE_KEY] = state;
    state.timer = setTimeout(restore, 20_000);
    return state;
  }

  function restore() {
    const state = globalThis[RESTORE_KEY];
    if (!state) return { restored: 0 };
    clearTimeout(state.timer);
    for (const entry of [...state.records].reverse()) {
      if (!entry.element?.isConnected) continue;
      if (entry.style === null) entry.element.removeAttribute("style");
      else entry.element.setAttribute("style", entry.style);
      if (entry.className === null) entry.element.removeAttribute("class");
      else entry.element.setAttribute("class", entry.className);
    }
    for (const element of state.extras) element?.remove?.();
    delete globalThis[RESTORE_KEY];
    return { restored: state.records.length, kind: state.kind };
  }

  function smallestTextContainer(phrase, options = {}) {
    const candidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .filter((element) => text(element).includes(phrase))
      .map((element) => ({ element, rect: element.getBoundingClientRect(), value: text(element) }))
      .filter((entry) => entry.rect.width >= (options.minWidth || 1) && entry.rect.height >= (options.minHeight || 1))
      .filter((entry) => !options.maxHeight || entry.rect.height <= options.maxHeight)
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    return candidates[0]?.element || null;
  }

  function prepareEcount() {
    if (identify() !== "ecount") return { applied: false, reason: "wrong_site" };
    const state = startRestoreState("ecount");
    const hidden = { modal: 0, backdrop: 0, advertisement: 0 };

    const pageSettingsCandidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((element) => ({ element, value: text(element), rect: element.getBoundingClientRect() }))
      .filter(({ value }) => /페이지\s*설정/.test(value) && ["용지종류", "인쇄정렬", "인쇄방향", "축소사용", "여백", "확인", "닫기"]
        .filter((token) => value.includes(token)).length >= 3)
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    let modal = pageSettingsCandidates[0]?.element || null;
    if (modal) {
      for (let ancestor = modal; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if ((style.position === "fixed" || style.position === "absolute") && text(ancestor).includes("페이지설정")) {
          modal = ancestor;
          break;
        }
      }
      record(modal, state.records);
      modal.style.setProperty("display", "none", "important");
      hidden.modal += 1;

      const viewportArea = Math.max(1, innerWidth * innerHeight);
      const overlays = [...document.querySelectorAll("body *")]
        .filter((element) => element !== modal && !element.contains(modal) && !modal.contains(element))
        .filter(visible)
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const value = text(element);
          return style.position === "fixed" && rect.width * rect.height >= viewportArea * 0.45 &&
            invoiceEvidence(value) < 5 && value.length < 100;
        });
      for (const overlay of overlays) {
        record(overlay, state.records);
        overlay.style.setProperty("display", "none", "important");
        hidden.backdrop += 1;
      }
    }

    for (const phrase of ["좋은 ERP를 찾고 계신가요?", "이카운트ERP 살펴보기"]) {
      const advertisement = smallestTextContainer(phrase, { minWidth: 250, minHeight: 40, maxHeight: 360 });
      if (!advertisement || invoiceEvidence(text(advertisement)) >= 5) continue;
      record(advertisement, state.records);
      advertisement.style.setProperty("display", "none", "important");
      hidden.advertisement += 1;
    }

    return { applied: state.records.length > 0, hidden, modalDetected: hidden.modal > 0 };
  }

  function prepareHometax() {
    if (identify() !== "hometax") return { applied: false, reason: "wrong_site" };
    const invoice = findInvoiceElement();
    if (!invoice) return { applied: false, reason: "invoice_not_found" };

    const invoiceRect = invoice.getBoundingClientRect();
    const controls = [...document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']")]
      .filter(visible)
      .map((element) => ({
        element,
        label: String(element.innerText || element.value || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, "")
          .trim(),
        rect: element.getBoundingClientRect()
      }))
      .filter((entry) => entry.label === "인쇄" || entry.label === "첨부보기")
      .filter((entry) => entry.rect.bottom <= invoiceRect.top + 180);

    const printButtons = controls.filter((entry) => entry.label === "인쇄");
    const attachmentButtons = controls.filter((entry) => entry.label === "첨부보기");
    let pair = null;
    let bestDistance = Infinity;
    for (const print of printButtons) {
      for (const attachment of attachmentButtons) {
        const distance = Math.abs(print.rect.top - attachment.rect.top) + Math.abs(print.rect.bottom - attachment.rect.bottom);
        const sameRow = distance < 80;
        const sharedContainer = print.element.parentElement === attachment.element.parentElement ||
          print.element.parentElement?.parentElement === attachment.element.parentElement?.parentElement;
        if (sameRow && sharedContainer && distance < bestDistance) {
          pair = [print.element, attachment.element];
          bestDistance = distance;
        }
      }
    }
    if (!pair) return { applied: false, reason: "target_buttons_not_found" };

    const state = startRestoreState("hometax_controls");
    for (const element of pair) {
      record(element, state.records);
      element.style.setProperty("display", "none", "important");
    }
    return { applied: true, hidden: pair.length };
  }

  function prepareInvoiceBoxOnly(expectedSite = "") {
    if (expectedSite && identify() !== expectedSite) {
      return { applied: false, reason: "wrong_site" };
    }

    const invoice = findInvoiceElement();
    if (!invoice) return { applied: false, reason: "invoice_not_found" };

    const state = startRestoreState(`${identify()}_invoice_box_only`);

    // 계산서 박스로 올라가는 DOM 경로 외의 sibling은 출력에서 제외합니다.
    let child = invoice;
    for (let parent = invoice.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      for (const sibling of parent.children) {
        if (sibling === child) continue;
        record(sibling, state.records);
        sibling.style.setProperty("display", "none", "important");
      }

      record(parent, state.records);
      parent.style.setProperty("position", "static", "important");
      parent.style.setProperty("float", "none", "important");
      parent.style.setProperty("max-width", "none", "important");
      parent.style.setProperty("min-width", "0", "important");
      parent.style.setProperty("min-height", "0", "important");
      parent.style.setProperty("height", "auto", "important");
      parent.style.setProperty("overflow", "visible", "important");
      parent.style.setProperty("margin", "0", "important");
      parent.style.setProperty("padding", "0", "important");
      child = parent;
    }

    if (child.parentElement === document.body) {
      for (const sibling of document.body.children) {
        if (sibling === child) continue;
        record(sibling, state.records);
        sibling.style.setProperty("display", "none", "important");
      }
    }

    for (const element of [document.documentElement, document.body]) {
      record(element, state.records);
      element.style.setProperty("background", "#fff", "important");
      element.style.setProperty("margin", "0", "important");
      element.style.setProperty("padding", "0", "important");
      element.style.setProperty("width", "100%", "important");
      element.style.setProperty("max-width", "none", "important");
      element.style.setProperty("min-height", "0", "important");
      element.style.setProperty("height", "auto", "important");
      element.style.setProperty("overflow", "visible", "important");
    }

    // 실제 계산서 박스의 비율/폭은 유지하고 가운데 정렬만 합니다.
    record(invoice, state.records);
    invoice.style.setProperty("display", invoice.tagName === "TABLE" ? "table" : "block", "important");
    invoice.style.setProperty("position", "static", "important");
    invoice.style.setProperty("float", "none", "important");
    invoice.style.setProperty("max-width", "100%", "important");
    invoice.style.setProperty("margin-left", "auto", "important");
    invoice.style.setProperty("margin-right", "auto", "important");
    invoice.style.setProperty("break-inside", "avoid", "important");
    invoice.style.setProperty("page-break-inside", "avoid", "important");
    invoice.style.setProperty("overflow", "visible", "important");

    const style = document.createElement("style");
    style.id = "hakdol-invoice-box-print-style";
    style.textContent = `
      @page { size: A4 portrait; margin: 6mm; }
      @media print {
        html, body {
          background: #fff !important;
          margin: 0 !important;
          padding: 0 !important;
          min-height: 0 !important;
          height: auto !important;
          overflow: visible !important;
        }
        button,
        input[type="button"],
        input[type="submit"],
        [role="button"] {
          display: none !important;
        }
      }
    `;
    document.documentElement.appendChild(style);
    state.extras.push(style);

    const rect = invoice.getBoundingClientRect();
    return {
      applied: true,
      evidence: invoiceEvidence(text(invoice)),
      junk: junkEvidence(text(invoice)),
      tag: invoice.tagName,
      width: rect.width,
      height: rect.height
    };
  }

  // 이전 버전 호출 호환용 wrapper
  function prepareInvoiceOnly(expectedSite) {
    return prepareInvoiceBoxOnly(expectedSite);
  }


  function rectToTopWindow(rect) {
    let x = rect.left;
    let y = rect.top;
    let win = window;
    try {
      while (win !== win.top) {
        const frame = win.frameElement;
        if (!frame || win.parent.getComputedStyle(frame).transform !== "none") return null;
        const frameRect = frame.getBoundingClientRect();
        x += frameRect.left + frame.clientLeft;
        y += frameRect.top + frame.clientTop;
        win = win.parent;
      }
      x += win.scrollX;
      y += win.scrollY;
    } catch (_) {
      return null;
    }
    return { x, y, width: rect.width, height: rect.height };
  }

  function unionRects(rects) {
    if (!rects.length) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
  }

  function invoiceVisualRegion() {
    // TaxBill365 같은 화면은 계산서 본체가 여러 sibling table로 구성되어
    // "가장 작은 공통 부모"가 발행정보/담당자 영역까지 포함할 수 있습니다.
    // 이 경우 DOM 부모가 아니라 실제 계산서 표들의 시각적 범위를 합쳐 잘라냅니다.
    const tables = [...document.querySelectorAll("table")]
      .filter(visible)
      .map((element) => {
        const value = text(element);
        const rect = element.getBoundingClientRect();
        return {
          element,
          value,
          rect,
          evidence: invoiceEvidence(value),
          junk: junkEvidence(value)
        };
      })
      .filter((entry) =>
        entry.rect.width >= 250 &&
        entry.rect.height >= 20 &&
        entry.rect.width < 6000 &&
        entry.rect.height < 12000
      );

    if (!tables.length) return null;

    const titlePattern = /전자\s*(?:세금)?\s*계산서/;
    const amountPattern = /합계\s*금액/;

    // 한 table 안에 계산서 본체 전체가 있고 부가정보가 없다면 그 table을 그대로 사용합니다.
    const complete = tables
      .filter((entry) =>
        titlePattern.test(entry.value) &&
        amountPattern.test(entry.value) &&
        hasInvoiceCore(entry.value) &&
        entry.junk === 0
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];

    if (complete) {
      const topRect = rectToTopWindow(complete.rect);
      if (!topRect) return null;
      const pad = 4;
      return {
        x: Math.max(0, topRect.x - pad),
        y: Math.max(0, topRect.y - pad),
        width: topRect.width + pad * 2,
        height: topRect.height + pad * 2,
        scale: 1,
        source: "single_table"
      };
    }

    const titleTables = tables
      .filter((entry) => titlePattern.test(entry.value) && entry.junk === 0)
      .sort((a, b) => a.rect.top - b.rect.top || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

    const amountTables = tables
      .filter((entry) => amountPattern.test(entry.value) && entry.junk === 0)
      .sort((a, b) => b.rect.bottom - a.rect.bottom || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

    const start = titleTables[0];
    const end = amountTables.find((entry) => !start || entry.rect.bottom >= start.rect.top);

    if (!start || !end) return null;

    const top = start.rect.top - 6;
    const bottom = end.rect.bottom + 6;

    const invoiceTerms = /(?:전자\s*(?:세금)?\s*계산서|승인\s*번호|공급\s*자|공급\s*받는\s*자|등록\s*번호|작성\s*일자?|공급\s*가액|품\s*(?:목|명)|합계\s*금액|현금|수표|어음|외상미수금)/;

    const included = tables.filter((entry) => {
      if (entry.junk > 0) return false;
      if (entry.rect.bottom < top || entry.rect.top > bottom) return false;
      return invoiceTerms.test(entry.value);
    });

    const localUnion = unionRects(included.map((entry) => entry.rect));
    if (!localUnion || localUnion.width < 350 || localUnion.height < 180) return null;

    const topRect = rectToTopWindow(localUnion);
    if (!topRect) return null;

    const pad = 4;
    return {
      x: Math.max(0, topRect.x - pad),
      y: Math.max(0, topRect.y - pad),
      width: topRect.width + pad * 2,
      height: topRect.height + pad * 2,
      scale: 1,
      source: "multi_table_union"
    };
  }

  function invoiceRegion() {
    const invoice = findInvoiceElement();
    if (!invoice) return null;
    const rect = invoice.getBoundingClientRect();
    let x = rect.left;
    let y = rect.top;
    let win = window;
    try {
      while (win !== win.top) {
        const frame = win.frameElement;
        if (!frame || win.parent.getComputedStyle(frame).transform !== "none") return null;
        const frameRect = frame.getBoundingClientRect();
        x += frameRect.left + frame.clientLeft;
        y += frameRect.top + frame.clientTop;
        win = win.parent;
      }
      x += win.scrollX;
      y += win.scrollY;
    } catch (_) {
      return null;
    }
    if (x < 0 || y < 0 || rect.width < 350 || rect.height < 180 || rect.width > 6000 || rect.height > 12000) return null;
    return { x, y, width: rect.width, height: rect.height, scale: 1 };
  }

  function safePrintUrl(expectedSite) {
    if (identify() !== expectedSite || !["smileedi", "smartbill"].includes(expectedSite)) return null;
    const controls = [...document.querySelectorAll("a,button,input[type=button],input[type=submit],[role=button]")]
      .filter(visible)
      .filter((element) => /^(?:인쇄|인쇄하기|출력|출력하기)$/.test(String(element.innerText || element.value || "").replace(/\s+/g, "").trim()));
    const printHint = /(?:print|prt|output|preview|submitType=print)/i;
    for (const control of controls) {
      const rawHref = control.getAttribute("href") || "";
      if (rawHref && !/^javascript:/i.test(rawHref)) {
        try {
          const url = new URL(rawHref, location.href);
          if (url.origin === location.origin && printHint.test(url.href)) return { url: url.href, source: "link" };
        } catch (_) { /* 잘못된 링크는 무시합니다. */ }
      }
      const onclick = control.getAttribute("onclick") || "";
      const literal = onclick.match(/["']([^"']*(?:print|prt|output|preview)[^"']*)["']/i)?.[1];
      if (literal) {
        try {
          const url = new URL(literal, location.href);
          if (url.origin === location.origin && printHint.test(url.href)) return { url: url.href, source: "onclick" };
        } catch (_) { /* 동적 함수 호출은 추측하지 않습니다. */ }
      }
      const form = control.closest("form");
      if (form && String(form.method || "get").toLowerCase() === "get") {
        const submitType = form.querySelector('[name="submitType"]')?.value || "";
        if (submitType === "print" || printHint.test(form.action || "")) {
          try {
            const url = new URL(form.action || location.href, location.href);
            if (url.origin !== location.origin) continue;
            for (const field of new FormData(form).entries()) url.searchParams.set(field[0], String(field[1]));
            return { url: url.href, source: "get_form" };
          } catch (_) { /* POST 또는 동적 폼은 사용하지 않습니다. */ }
        }
      }
    }
    return null;
  }

  function inspect() {
    const adapter = identify();
    const invoice = findInvoiceElement();
    const settings = adapter === "ecount" && /페이지\s*설정/.test(text(document.body));
    return {
      adapter,
      invoice: Boolean(invoice),
      evidence: invoice ? invoiceEvidence(text(invoice)) : 0,
      settings,
      embedded: document.querySelectorAll("iframe,frame,embed,object").length
    };
  }

  globalThis.HakdolPrint = {
    identify,
    inspect,
    prepareEcount,
    prepareHometax,
    prepareInvoiceBoxOnly,
    prepareInvoiceOnly,
    invoiceVisualRegion,
    invoiceRegion,
    safePrintUrl,
    restore
  };
})();
