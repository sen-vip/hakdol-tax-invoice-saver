(() => {
  const adapters = Array.isArray(globalThis.HAKDOL_SITE_ADAPTERS)
    ? globalThis.HAKDOL_SITE_ADAPTERS
    : [];
  const LABELS = {
    supplier: [
      "공급자 상호", "공급자상호", "상호(법인명)", "상호", "법인명",
      "공급자명", "업체명", "거래처명"
    ],
    item: ["품목명", "품명", "품목", "거래품목", "공급품목"],
    date: ["작성일자", "작성일", "발행일자", "발행일", "공급일자"],
    amount: ["합계금액", "총금액", "청구금액", "공급대가", "결제금액"]
  };

  const COMMON_HEADERS = [
    ...Object.values(LABELS).flat(),
    "월", "일", "규격", "수량", "단가", "공급가액", "세액", "비고",
    "현금", "수표", "어음", "외상미수금", "수정사유", "종사업장번호",
    "등록번호", "성명", "대표자", "주소", "업태", "종목", "이메일"
  ];

  const INVALID_VALUE_WORDS = [
    "등록번호", "성명", "대표자", "주소", "업태", "종목", "공급받는자",
    "공급자", "이메일", "합계", "세액", "공급가액", "규격",
    "(법인명)", "법인명)", "(상호)", "상호)"
  ];

  function clean(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[:：\-–—|]+|[:：\-–—|]+$/g, "")
      .trim();
  }

  function isUseful(value, maxLength = 80) {
    const text = clean(value);
    return Boolean(
      text &&
      text.length <= maxLength &&
      !INVALID_VALUE_WORDS.some((word) => text === word)
    );
  }

  function exactLabel(text, labels) {
    const normalized = clean(text).replace(/\s/g, "");
    return labels.some((label) => normalized === label.replace(/\s/g, ""));
  }

  function stripLeadingLabel(text, labels) {
    const original = clean(text);
    if (exactLabel(original, labels)) return "";

    const longestFirst = [...labels].sort((a, b) => b.length - a.length);
    for (const label of longestFirst) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = original.match(new RegExp(`^${escaped}\\s*[:：]?\\s*(.+)$`, "i"));
      if (match && isUseful(match[1]) && !exactLabel(match[1], COMMON_HEADERS)) return clean(match[1]);
    }
    return "";
  }

  function tableRows() {
    return [...document.querySelectorAll("tr")].map((row) =>
      [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) => clean(cell.innerText))
    ).filter((cells) => cells.length);
  }

  function valuesBesideLabels(labels) {
    const candidates = [];

    for (const cells of tableRows()) {
      cells.forEach((cell, index) => {
        const inline = stripLeadingLabel(cell, labels);
        if (inline) candidates.push(inline);

        if (!exactLabel(cell, labels)) return;
        for (let next = index + 1; next < Math.min(cells.length, index + 4); next += 1) {
          if (isUseful(cells[next]) && !exactLabel(cells[next], COMMON_HEADERS)) {
            candidates.push(cells[next]);
            break;
          }
        }
      });
    }

    const elements = [...document.querySelectorAll("th, td, dt, dd, label, span, div, p")];
    for (const element of elements) {
      const ownText = clean(element.innerText);
      if (!ownText || ownText.length > 120) continue;

      const inline = stripLeadingLabel(ownText, labels);
      if (inline) candidates.push(inline);

      if (!exactLabel(ownText, labels)) continue;
      const possible = [
        element.nextElementSibling,
        element.parentElement?.nextElementSibling,
        element.parentElement?.querySelector("input, textarea, [data-value]")
      ];
      for (const node of possible) {
        const value = clean(node?.value || node?.dataset?.value || node?.innerText);
        if (isUseful(value) && !exactLabel(value, COMMON_HEADERS)) {
          candidates.push(value);
          break;
        }
      }
    }

    return [...new Set(candidates.map(clean).filter(Boolean))];
  }

  function valuesBelowLabels(labels, maxRows = 4) {
    const candidates = [];
    const tables = [...document.querySelectorAll("table")];

    for (const table of tables) {
      const rows = [...table.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) => clean(cell.innerText))
      );

      rows.forEach((cells, rowIndex) => {
        cells.forEach((cell, columnIndex) => {
          if (!exactLabel(cell, labels)) return;
          for (let nextRow = rowIndex + 1; nextRow < Math.min(rows.length, rowIndex + 1 + maxRows); nextRow += 1) {
            const value = rows[nextRow][columnIndex];
            if (!isUseful(value, 120) || exactLabel(value, COMMON_HEADERS)) continue;
            candidates.push(value);
            break;
          }
        });
      });
    }

    return [...new Set(candidates.map(clean).filter(Boolean))];
  }

  function parseDate(value) {
    const text = clean(value);
    let match = text.match(/(20\d{2})[.\-/년\s]+(1[0-2]|0?[1-9])[.\-/월\s]+(3[01]|[12]\d|0?[1-9])/);
    if (!match) match = text.match(/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
    if (!match) return "";
    return `${match[1]}${String(match[2]).padStart(2, "0")}${String(match[3]).padStart(2, "0")}`;
  }

  function findSplitDatesFromTables() {
    const results = [];
    const tables = [...document.querySelectorAll("table")];

    for (const table of tables) {
      const rows = [...table.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) => clean(cell.innerText))
      );

      rows.forEach((cells, labelRowIndex) => {
        if (!cells.some((cell) => exactLabel(cell, LABELS.date))) return;

        for (let unitRowIndex = labelRowIndex + 1; unitRowIndex < Math.min(rows.length, labelRowIndex + 4); unitRowIndex += 1) {
          const unitRow = rows[unitRowIndex];
          const yearIndex = unitRow.findIndex((value) => value === "년");
          const monthIndex = unitRow.findIndex((value, index) => index > yearIndex && value === "월");
          const dayIndex = unitRow.findIndex((value, index) => index > monthIndex && value === "일");
          if (yearIndex < 0 || monthIndex < 0 || dayIndex < 0) continue;

          for (let valueRowIndex = unitRowIndex + 1; valueRowIndex < Math.min(rows.length, unitRowIndex + 4); valueRowIndex += 1) {
            const valueRow = rows[valueRowIndex];
            const year = clean(valueRow[yearIndex]);
            const month = clean(valueRow[monthIndex]);
            const day = clean(valueRow[dayIndex]);
            if (!/^20\d{2}$/.test(year) || !/^(?:0?[1-9]|1[0-2])$/.test(month) || !/^(?:0?[1-9]|[12]\d|3[01])$/.test(day)) continue;

            const parsed = parseDate(`${year}-${month}-${day}`);
            if (parsed) results.push(parsed);
            break;
          }
        }
      });
    }

    return [...new Set(results)];
  }

  function parseAmount(value) {
    const matches = clean(value).match(/[\d,]+/g);
    if (!matches) return "";
    const number = matches
      .map((part) => Number(part.replace(/,/g, "")))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    return number ? String(number) : "";
  }

  function findItemsFromTables() {
    const results = [];
    const tables = [...document.querySelectorAll("table")];

    for (const table of tables) {
      const rows = [...table.querySelectorAll("tr")].filter((row) => row.closest("table") === table).map((row) =>
        [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) => clean(cell.innerText))
      );

      rows.forEach((cells, rowIndex) => {
        cells.forEach((cell, columnIndex) => {
          if (!exactLabel(cell, LABELS.item)) return;

          const sameRow = cells[columnIndex + 1];
          if (cells.length <= 2 && isUseful(sameRow, 100) && !exactLabel(sameRow, COMMON_HEADERS)) {
            results.push({ names: [sameRow], count: 0 });
          }

          const hasColumns = cells.some((value) => /^(수량|단가|공급가액)$/.test(value));
          if (!hasColumns) return;

          const names = [];
          for (let nextRow = rowIndex + 1; nextRow < rows.length; nextRow += 1) {
            if (exactLabel(rows[nextRow][columnIndex], LABELS.item)) break;
            if (rows[nextRow].some((value) => /^(합계|합계금액|공급가액\s*합계|세액\s*합계|현금|수표|어음|외상미수금|비고)$/.test(value))) break;
            if (rows[nextRow].length !== cells.length) continue;
            const value = rows[nextRow][columnIndex];
            if (!isUseful(value, 100) || exactLabel(value, COMMON_HEADERS)) continue;
            if (/^[\d,./\-]+(?:원)?$/.test(value) || /^(전체|영수|청구)$/.test(value)) continue;
            const numericEvidence = cells.some((header, index) =>
              /^(수량|단가|공급가액)$/.test(header) && /^-?[\d,]+(?:\.\d+)?$/.test(rows[nextRow][index]));
            if (!numericEvidence) continue;
            names.push(value);
          }
          if (names.length) results.push({ names, count: names.length });
        });
      });
    }

    return results.find((result) => result.count > 0) || results[0] || { names: [], count: 0 };
  }

  function compactItem(values, rowCount = 0) {
    const blocked = /^(월|일|규격|수량|단가|공급가액|세액|비고|합계|현금|수표|어음|외상미수금)$/;
    const valid = [...new Set(values
      .map(clean)
      .filter((value) => isUseful(value, 100) && !blocked.test(value)))];

    if (!valid.length) return "";
    const first = valid[0].slice(0, 36);
    if (rowCount < 2) return first;
    return /\s외$/.test(first) ? first : `${first} 외`;
  }

  function readAdapter() {
    const adapter = adapters.find((entry) =>
      Array.isArray(entry.hosts) && entry.hosts.some((host) => location.hostname === host || location.hostname.endsWith(`.${host}`))
    );
    if (!adapter) return {};

    const result = {};
    const selectorMap = adapter.selectors || {};
    for (const key of ["supplier", "item", "date", "amount"]) {
      const selectors = Array.isArray(selectorMap[key]) ? selectorMap[key] : [];
      for (const selector of selectors) {
        let node;
        try {
          node = document.querySelector(selector);
        } catch (_) {
          continue;
        }
        const value = clean(node?.value || node?.getAttribute?.("content") || node?.innerText);
        if (value) {
          result[key] = value;
          break;
        }
      }
    }
    const customReaders = {
      supplier: "readSupplier",
      date: "readDate",
      amount: "readAmount"
    };
    for (const [key, readerName] of Object.entries(customReaders)) {
      if (result[key] || typeof adapter[readerName] !== "function") continue;
      try {
        result[key] = clean(adapter[readerName]());
      } catch (_) {
        // 사이트 fallback 실패는 공통 추출을 방해하지 않습니다.
      }
    }

    if (typeof adapter.readItems === "function") {
      try {
        const itemsResult = adapter.readItems();
        if (Array.isArray(itemsResult)) {
          const names = itemsResult.map(clean).filter(Boolean);
          if (names.length) {
            result.item = names[0];
            result.itemCount = names.length;
          }
        } else if (itemsResult && typeof itemsResult === "object") {
          const names = Array.isArray(itemsResult.names)
            ? itemsResult.names.map(clean).filter(Boolean)
            : [];
          if (names.length) result.item = names[0];
          const count = Number(itemsResult.count);
          if (Number.isFinite(count) && count > 0) result.itemCount = count;
        }
      } catch (_) {
        // 사이트 품목 fallback 실패는 공통 추출을 방해하지 않습니다.
      }
    }
    return result;
  }

  const bodyText = clean(document.body?.innerText || "");
  const adapterData = readAdapter();
  const supplierCandidates = valuesBesideLabels(LABELS.supplier)
    .filter((value) => !/^\d{3}-?\d{2}-?\d{5}$/.test(value))
    .filter((value) => !/^\(?\s*(법인명|상호)\s*\)?$/.test(value));
  const itemTable = findItemsFromTables();
  const itemCandidates = [...itemTable.names, ...valuesBesideLabels(LABELS.item)];
  const dateCandidates = [...findSplitDatesFromTables(), ...valuesBelowLabels(LABELS.date), ...valuesBesideLabels(LABELS.date)]
    .map(parseDate).filter(Boolean);
  const amountCandidates = [...valuesBelowLabels(LABELS.amount), ...valuesBesideLabels(LABELS.amount)]
    .map(parseAmount).filter(Boolean);

  if (!dateCandidates.length) {
    const labeledDate = bodyText.match(/(?:작성일자?|발행일자?|공급일자?)\s*[:：]?\s*((?:20\d{2})[.\-/년\s]+\d{1,2}[.\-/월\s]+\d{1,2})/);
    if (labeledDate) dateCandidates.push(parseDate(labeledDate[1]));
  }

  const supplier = clean(adapterData.supplier) || supplierCandidates.find((value) =>
    !/^(세금계산서|전자세금계산서|영수|청구)$/.test(value)
  ) || "";
  const itemRowCount = Math.max(Number(adapterData.itemCount || 0), itemTable.count);
  const item = compactItem([adapterData.item, ...itemCandidates].filter(Boolean), itemRowCount);
  const date = parseDate(adapterData.date) || dateCandidates[0] || "";
  const amount = parseAmount(adapterData.amount) || amountCandidates[0] || "";

  let score = /세금계산서/.test(bodyText + document.title) ? 4 : 0;
  if (supplier) score += 4;
  if (item) score += 3;
  if (date) score += 3;
  if (amount) score += 1;

  return {
    supplier,
    item,
    date,
    amount,
    score,
    title: document.title,
    url: location.href
  };
})();
