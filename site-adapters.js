// 공통 추출기가 먼저 작동하고, 사이트에서만 필요한 최소 fallback만 둡니다.
(() => {
  function cellText(cell) {
    const controls = [...(cell?.querySelectorAll?.("input, select, textarea") || [])]
      .map((control) => control.value)
      .filter(Boolean);
    const visibleText = cell?.innerText ?? cell?.textContent;
    return [visibleText, ...controls]
      .filter(Boolean)
      .join(" ")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function validDate(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (!Number.isInteger(y) || y < 2000 || y > 2099) return "";
    if (!Number.isInteger(m) || m < 1 || m > 12) return "";
    if (!Number.isInteger(d) || d < 1 || d > 31) return "";
    return `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
  }

  function tableRows(table) {
    return [...table.querySelectorAll("tr")].map((row) => {
      const directCells = [...row.querySelectorAll(":scope > th, :scope > td")];
      const cells = directCells.length
        ? directCells
        : [...row.querySelectorAll("[role='columnheader'], [role='cell']")];
      return cells.map(cellText);
    }).filter((cells) => cells.length);
  }

  function splitDateFromRows(rows) {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const unitRow = rows[rowIndex];
      const yearIndex = unitRow.findIndex((value) => /^년$/.test(value));
      const monthIndex = unitRow.findIndex((value, index) => yearIndex >= 0 && index > yearIndex && /^월$/.test(value));
      const dayIndex = unitRow.findIndex((value, index) => monthIndex >= 0 && index > monthIndex && /^일$/.test(value));
      if (yearIndex < 0 || monthIndex < 0 || dayIndex < 0) continue;

      for (let next = rowIndex + 1; next < Math.min(rows.length, rowIndex + 4); next += 1) {
        const year = String(rows[next][yearIndex] || "").match(/20\d{2}/)?.[0] || "";
        const month = String(rows[next][monthIndex] || "").match(/\d{1,2}/)?.[0] || "";
        const day = String(rows[next][dayIndex] || "").match(/\d{1,2}/)?.[0] || "";
        const result = validDate(year, month, day);
        if (result) return result;
      }
    }
    return "";
  }

  function ecountSplitDate() {
    if (!/(^|\.)ecount\.com$/i.test(location.hostname)) return "";
    const tables = [...document.querySelectorAll("table")];

    for (const table of tables) {
      const tableText = cellText(table);
      // 실제 eCount 양식은 상단 라벨이 '작성일'이 아니라 '작성'으로 분리되는 경우가 있다.
      // 따라서 '년/월/일' 3열 + 공급가액 문맥으로 작성일 영역을 식별한다.
      if (!/공급\s*가액/.test(tableText)) continue;
      const rows = tableRows(table);
      const result = splitDateFromRows(rows);
      if (result) return result;

      const compact = tableText.replace(/\s+/g, " ");
      const separated = compact.match(/(?:작성\s*일?|공급\s*가액)[\s\S]{0,700}?년\s+월\s+일[\s\S]{0,400}?(20\d{2})\D+(1[0-2]|0?[1-9])\D+(3[01]|[12]\d|0?[1-9])/);
      if (separated) {
        const fallback = validDate(separated[1], separated[2], separated[3]);
        if (fallback) return fallback;
      }
    }
    return "";
  }

  function freebillSplitDate() {
    if (!/(^|\.)freebill\.co\.kr$/i.test(location.hostname)) return "";
    const tables = [...document.querySelectorAll("table")];

    for (const table of tables) {
      const tableText = cellText(table);
      if (!/공급\s*가액/.test(tableText)) continue;
      const result = splitDateFromRows(tableRows(table));
      if (result) return result;

      const direct = tableText.match(/(?:작성\s*일자?|발행\s*일자?)\s*[:：]?\s*(20\d{2})[.\-/년\s]+(1[0-2]|0?[1-9])[.\-/월\s]+(3[01]|[12]\d|0?[1-9])/);
      if (direct) {
        const fallback = validDate(direct[1], direct[2], direct[3]);
        if (fallback) return fallback;
      }
    }
    return "";
  }


  function normalizedLabel(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, "")
      .replace(/[＊*]/g, "")
      .replace(/[:：]/g, "")
      .trim();
  }

  function firstValueAfterLabel(row, labelIndex, blocked = []) {
    for (let index = labelIndex + 1; index < Math.min(row.length, labelIndex + 4); index += 1) {
      const value = String(row[index] || "").replace(/\s+/g, " ").trim();
      if (!value) continue;
      const compact = normalizedLabel(value);
      if (blocked.some((label) => compact === normalizedLabel(label))) continue;
      return value;
    }
    return "";
  }

  function etradebillTables() {
    if (!/(^|\.)etradebill\.co\.kr$/i.test(location.hostname)) return [];
    return [...document.querySelectorAll("table")];
  }

  function etradebillSupplier() {
    const blocked = ["상호(업체명)", "상호(법인명)", "업체명", "공급자", "공급받는자"];

    for (const table of etradebillTables()) {
      const tableText = cellText(table);
      // 공급자/공급받는자가 함께 있는 본문 표를 우선 대상으로 삼습니다.
      if (!/공급\s*자/.test(tableText) || !/공급\s*받는\s*자/.test(tableText)) continue;

      for (const row of tableRows(table)) {
        const matches = [];
        row.forEach((cell, index) => {
          const label = normalizedLabel(cell);
          if (label === "상호(업체명)" || label === "상호(법인명)") {
            const value = firstValueAfterLabel(row, index, blocked);
            if (value) matches.push({ index, value });
          }
        });

        // eTradeBill은 공급자가 좌측, 공급받는자가 우측입니다.
        // 동일 행에 두 상호가 있으면 좌측 상호를 공급자 업체명으로 사용합니다.
        if (matches.length) {
          matches.sort((a, b) => a.index - b.index);
          return matches[0].value;
        }
      }
    }
    return "";
  }

  function parseDirectDate(value) {
    const text = String(value || "").trim();
    const match = text.match(/(20\d{2})[.\-/년\s]*(1[0-2]|0?[1-9])[.\-/월\s]*(3[01]|[12]\d|0?[1-9])/);
    if (!match) return "";
    return validDate(match[1], match[2], match[3]);
  }

  function etradebillDate() {
    for (const table of etradebillTables()) {
      for (const row of tableRows(table)) {
        const labelIndex = row.findIndex((cell) => {
          const label = normalizedLabel(cell);
          return label === "작성일자" || label === "작성일";
        });
        if (labelIndex < 0) continue;

        const sameRow = firstValueAfterLabel(row, labelIndex, ["작성일자", "작성일", "수정사유"]);
        const parsed = parseDirectDate(sameRow);
        if (parsed) return parsed;
      }
    }

    // 폼 구조가 행 단위로 분리된 경우를 위한 좁은 fallback
    const pageText = cellText(document.body || document.documentElement);
    const direct = pageText.match(/작성\s*일자?\s*[:：]?\s*(20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
    return direct ? parseDirectDate(direct[1]) : "";
  }

  function etradebillItems() {
    for (const table of etradebillTables()) {
      const rows = tableRows(table);

      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const headers = rows[rowIndex];
        const itemIndex = headers.findIndex((value) => normalizedLabel(value) === "품목");
        if (itemIndex < 0) continue;

        const hasInvoiceColumns = headers.some((value) => /^(수량|단가|공급가액)$/.test(normalizedLabel(value)));
        if (!hasInvoiceColumns) continue;

        const names = [];
        for (let next = rowIndex + 1; next < rows.length; next += 1) {
          const data = rows[next];
          if (data.some((value) => /^(합계금액|현금|수표|어음|외상미수금)$/.test(normalizedLabel(value)))) break;

          const value = String(data[itemIndex] || "").replace(/\s+/g, " ").trim();
          if (!value) continue;

          const compact = normalizedLabel(value);
          if (/^(월|일|품목|규격|수량|단가|공급가액|세액|비고|합계금액)$/.test(compact)) continue;
          if (/^(단가공급가액세액비고|공급가액세액비고)$/.test(compact)) continue;
          if (/^[\d,./\-]+(?:원)?$/.test(value)) continue;

          // 수량/단가/공급가액 중 하나라도 숫자 데이터가 있으면 실제 품목행으로 봅니다.
          const numericEvidence = headers.some((header, index) =>
            /^(수량|단가|공급가액)$/.test(normalizedLabel(header)) &&
            /^-?[\d,]+(?:\.\d+)?$/.test(String(data[index] || "").replace(/\s+/g, ""))
          );
          if (!numericEvidence) continue;

          names.push(value);
        }

        if (names.length) return { names, count: names.length };
      }
    }
    return { names: [], count: 0 };
  }

  function etradebillAmount() {
    for (const table of etradebillTables()) {
      const rows = tableRows(table);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const labelIndex = row.findIndex((cell) => normalizedLabel(cell) === "합계금액");
        if (labelIndex < 0) continue;

        const sameRow = firstValueAfterLabel(row, labelIndex, ["합계금액", "현금", "수표", "어음", "외상미수금"]);
        if (/[\d,]+/.test(sameRow)) return sameRow;

        for (let next = rowIndex + 1; next < Math.min(rows.length, rowIndex + 3); next += 1) {
          const value = String(rows[next][labelIndex] || "").trim();
          if (/[\d,]+/.test(value)) return value;
        }
      }
    }
    return "";
  }

  globalThis.HAKDOL_SITE_ADAPTERS = [
    {
      id: "ecount",
      hosts: ["ecount.com"],
      selectors: {},
      readDate: ecountSplitDate
    },
    {
      id: "freebill",
      hosts: ["freebill.co.kr"],
      selectors: {},
      readDate: freebillSplitDate
    },
    {
      id: "etradebill",
      hosts: ["etradebill.co.kr"],
      selectors: {},
      readSupplier: etradebillSupplier,
      readDate: etradebillDate,
      readItems: etradebillItems,
      readAmount: etradebillAmount
    }
  ];
})();
