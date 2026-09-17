const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
let passed = 0;
const pass = (name) => { passed += 1; console.log("PASS", name); };

function makeTable(values) {
  const table = { rows: [], innerText: values.flat().join(" "), textContent: values.flat().join(" ") };
  table.rows = values.map((valuesInRow) => {
    const row = { closest: () => table, innerText: valuesInRow.join(" ") };
    row.cells = valuesInRow.map((value) => ({
      innerText: value,
      textContent: value,
      getAttribute: () => null,
      querySelectorAll: () => []
    }));
    row.querySelectorAll = () => row.cells;
    return row;
  });
  table.querySelectorAll = () => table.rows;
  return table;
}


function makeValueTable(values) {
  const allControls = [];
  const table = { rows: [] };

  table.rows = values.map((valuesInRow) => {
    const row = { closest: () => table };
    row.cells = valuesInRow.map((raw) => {
      const spec = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : { text: String(raw ?? "") };
      const controls = [];
      if (Object.prototype.hasOwnProperty.call(spec, "value")) {
        const control = { value: String(spec.value ?? "") };
        controls.push(control);
        allControls.push(control);
      }
      const text = String(spec.text ?? "");
      return {
        innerText: text,
        textContent: text,
        getAttribute: () => null,
        querySelectorAll(selector) {
          return /input|select|textarea/.test(selector) ? controls : [];
        }
      };
    });
    row.innerText = row.cells.map((cell) => cell.innerText).join(" ");
    row.querySelectorAll = () => row.cells;
    return row;
  });

  table.innerText = table.rows.map((row) => row.innerText).join(" ");
  table.textContent = table.innerText;
  table.querySelectorAll = (selector) => {
    if (selector === "tr") return table.rows;
    if (/input|select|textarea/.test(selector)) return allControls;
    return table.rows;
  };
  return table;
}

function adapterDate(table, hostname, adapterId) {
  const context = {
    document: { querySelectorAll: (selector) => selector === "table" ? [table] : [] },
    location: { hostname }
  };
  vm.createContext(context);
  vm.runInContext(read("site-adapters.js"), context);
  const adapter = context.HAKDOL_SITE_ADAPTERS.find((entry) => entry.id === adapterId);
  return adapter?.readDate?.() || "";
}

function ecountAdapterDate(table, hostname = "invoice.ecount.com") {
  return adapterDate(table, hostname, "ecount");
}

function freebillAdapterDate(table, hostname = "s2b.manager.freebill.co.kr") {
  return adapterDate(table, hostname, "freebill");
}


function etradebillAdapter(table, hostname = "www.etradebill.co.kr") {
  const context = {
    document: {
      body: table,
      documentElement: table,
      querySelectorAll: (selector) => selector === "table" ? [table] : []
    },
    location: { hostname }
  };
  vm.createContext(context);
  vm.runInContext(read("site-adapters.js"), context);
  return context.HAKDOL_SITE_ADAPTERS.find((entry) => entry.id === "etradebill");
}

function extract(tables, extraElements = [], options = {}) {
  const rows = tables.flatMap((table) => table.rows);
  const document = {
    title: "전자세금계산서",
    body: { innerText: "전자세금계산서" },
    querySelectorAll(selector) {
      if (selector === "table") return tables;
      if (selector === "tr") return rows;
      return [...rows.flatMap((row) => row.cells), ...extraElements];
    },
    querySelector: () => null
  };
  const context = {
    document,
    location: {
      hostname: options.hostname || "example.test",
      href: `https://${options.hostname || "example.test"}/invoice`
    }
  };
  vm.createContext(context);
  if (options.loadAdapters) vm.runInContext(read("site-adapters.js"), context);
  return vm.runInContext(read("extractor.js"), context);
}

function itemTable(names) {
  return makeTable([
    ["월", "일", "품목", "규격", "수량", "단가", "공급가액"],
    ...names.map((name) => ["09", "14", name, "전체", "1", "600000", "600000"]),
    ["", "", "", "", "", "", ""],
    ["합계금액", "현금", "수표"]
  ]);
}

function metadataTable() {
  return makeTable([
    ["상호(법인명)", "테스트청소"],
    ["작성일자", "공급가액", "세액"],
    ["년", "월", "일"],
    ["2026", "09", "14"],
    ["합계금액", "현금"],
    ["660,000", ""]
  ]);
}

function authFunction() {
  const source = read("popup.js");
  const start = source.indexOf("async function completeAccessGateInPage");
  const end = source.indexOf("async function runAccessGate", start);
  return source.slice(start, end);
}

async function authCase({ body, hostname = "link.smileedi.com", includeInput = true, ignoreValue = false }) {
  const events = [];
  let clicks = 0;
  class HTMLInputElement {
    constructor() {
      this.type = "text";
      this.maxLength = 12;
      this.labels = [];
      this.placeholder = "";
      this.name = "businessNumber";
      this.id = "businessNumber";
      this._value = "";
    }
    set value(value) { if (!ignoreValue) this._value = value; }
    get value() { return this._value; }
    getAttribute() { return ""; }
    getBoundingClientRect() { return { width: 200, height: 30 }; }
    closest(selector) { return selector === "form" ? form : { innerText: "사업자번호" }; }
    dispatchEvent(event) { events.push(event.type); }
    focus() {}
    blur() { events.push("blur"); }
  }
  const input = new HTMLInputElement();
  const button = {
    innerText: "확인", value: "", title: "", type: "button",
    getAttribute: () => "",
    getBoundingClientRect: () => ({ width: 60, height: 30 }),
    click: () => { clicks += 1; }
  };
  const form = { innerText: "사업자번호 확인", querySelectorAll: () => [button], contains: (node) => node === button };
  const context = {
    document: {
      body: { innerText: body },
      querySelectorAll: (selector) => selector.startsWith("input:not") ? (includeInput ? [input] : []) : [button]
    },
    location: { hostname },
    HTMLInputElement,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    Event: class { constructor(type) { this.type = type; } },
    setTimeout
  };
  vm.createContext(context);
  vm.runInContext(authFunction(), context);
  const result = await context.completeAccessGateInPage("123-45-67890", true);
  return { result, input, events, clicks };
}

(async () => {
  const one = extract([metadataTable(), itemTable(["후드목 및 덕트입구청소"])], [{ innerText: "품명: 다른 후보" }]);
  assert.equal(one.item, "후드목 및 덕트입구청소");
  assert.equal(one.supplier, "테스트청소");
  assert.equal(one.date, "20260914");
  assert.equal(one.amount, "660000");
  pass("품목 1행 외 없음 + 기존 메타데이터 인식");

  assert.equal(extract([itemTable(["복사용지", "토너"])]).item, "복사용지 외");
  assert.equal(extract([itemTable(["복사용지", "복사용지"])]).item, "복사용지 외");
  pass("실제 품목 2행 외 추가");

  assert.equal(extract([itemTable(["복사용지"]), itemTable(["복사용지"])]).item, "복사용지");
  assert.equal(extract([makeTable([["품명", "복사용지"]])], [{ innerText: "품명: 토너" }]).item, "복사용지");
  pass("중복 표·후보 문자열로 외를 붙이지 않음");

  const ecountDateTable = makeTable([
    ["작성", "공급가액", "세액", "수정사유"],
    ["년", "월", "일", "십억", "일억"],
    ["2026", "08", "25", "4", "4"]
  ]);
  assert.equal(ecountAdapterDate(ecountDateTable), "20260825");
  assert.equal(ecountAdapterDate(makeTable([
    ["작성", "공급가액"], ["년", "월", "일"], ["2026", "13", "25"]
  ])), "");
  assert.equal(ecountAdapterDate(ecountDateTable, "example.test"), "");
  pass("eCount 분리 셀 작성일 fallback + 날짜·호스트 검증");

  const freebillDateTable = makeTable([
    ["작성", "공급가액", "세액", "수정사유"],
    ["년", "월", "일", "십억", "일억"],
    ["2026", "09", "09", "1", "1"]
  ]);
  assert.equal(freebillAdapterDate(freebillDateTable), "20260909");
  assert.equal(freebillAdapterDate(freebillDateTable, "example.test"), "");
  pass("FreeBill 분리 셀 작성일 fallback + 호스트 검증");

  const ecountInvoice = extract([
    makeTable([
      ["상호(법인명)", "(주)테스트렌탈"],
      ["작성", "공급가액", "세액", "수정사유"],
      ["년", "월", "일", "십억"],
      ["2026", "08", "25", "4"],
      ["합계금액", "현금"],
      ["440,000", ""]
    ]),
    itemTable(["컬러복사기렌탈"])
  ], [], { hostname: "invoice.ecount.com", loadAdapters: true });
  assert.equal(ecountInvoice.supplier, "(주)테스트렌탈");
  assert.equal(ecountInvoice.item, "컬러복사기렌탈");
  assert.equal(ecountInvoice.date, "20260825");
  assert.equal(ecountInvoice.amount, "440000");
  pass("eCount 작성일 보강 후 업체명·품명·합계금액 회귀 없음");


  const etradeTable = makeValueTable([
    ["공급자", "사업자번호", { value: "111-22-33333" }, "공급받는자", "사업자번호", { value: "123-45-67890" }],
    ["상호(업체명)*", { value: "테스트공급자" }, "상호(업체명)*", { value: "테스트학교" }],
    ["대표자*", { value: "정갑윤" }, "대표자*", { value: "조인기" }],
    ["작성일자*", { value: "2026-08-31" }, "수정사유", { value: "" }],
    ["합계금액", { value: "10,000" }, "현금", { value: "" }],
    ["월", "일", "품목", "규격", "수량", "단가", "공급가액", "세액", "비고"],
    [{ value: "08" }, { value: "31" }, { value: "테스트품목 1건" }, { value: "-" }, { value: "1" }, { value: "9,091" }, { value: "9,091" }, { value: "909" }, { value: "" }]
  ]);
  const etradeAdapter = etradebillAdapter(etradeTable);
  assert.equal(etradeAdapter.readSupplier(), "테스트공급자");
  assert.equal(etradeAdapter.readDate(), "20260831");
  assert.deepEqual(
    JSON.parse(JSON.stringify(etradeAdapter.readItems())),
    { names: ["테스트품목 1건"], count: 1 }
  );
  assert.equal(etradeAdapter.readAmount(), "10,000");

  const etradeInvoice = extract([etradeTable], [], {
    hostname: "www.etradebill.co.kr",
    loadAdapters: true
  });
  assert.equal(etradeInvoice.supplier, "테스트공급자");
  assert.equal(etradeInvoice.item, "테스트품목 1건");
  assert.equal(etradeInvoice.date, "20260831");
  assert.equal(etradeInvoice.amount, "10000");
  assert.notEqual(etradeInvoice.supplier, "테스트학교");
  assert.notEqual(etradeInvoice.item, "단가 공급가액 세액 비고");
  pass("eTradeBill 공급자·작성일·품목·합계금액 전용 추출 + 헤더 오탐 방지");

  const smile = await authCase({ body: "SmileEDI 전자(세금)계산서 조회 사업자번호를 입력 후 확인" });
  assert.equal(smile.result.clicked, true);
  assert.equal(smile.input.value, "1234567890");
  assert.deepEqual(smile.events, ["input", "change", "blur"]);
  assert.equal(smile.clicks, 1);
  pass("SmileEDI 하이픈 제거·이벤트·값 확인 후 클릭");

  const popupAuthSource = authFunction();
  assert.match(popupAuthSource, /사업자번호가 3칸\(3-2-5\)/);
  assert.match(popupAuthSource, /number\.slice\(0, 3\)[\s\S]*number\.slice\(3, 5\)[\s\S]*number\.slice\(5\)/);
  assert.match(popupAuthSource, /split\.inputs\.forEach/);
  pass("사업자번호 3-2-5 분할 입력 로직 포함");

  const noInput = await authCase({ body: "사업자번호를 입력 후 확인", includeInput: false });
  assert.equal(noInput.result.matched, false);
  assert.equal(noInput.clicks, 0);
  pass("실제 입력칸이 없으면 인증 상태로 단정하지 않음");

  const invoice = await authCase({ body: "공급자 공급받는자 작성일 공급가액 세액 합계금액 품목 사업자번호 입력" });
  assert.equal(invoice.result.invoiceOpen, true);
  assert.equal(invoice.clicks, 0);
  pass("계산서 DOM이 있으면 분석 우선");

  const failed = await authCase({ body: "사업자번호를 입력 후 확인", ignoreValue: true });
  assert.equal(failed.result.reason, "value_not_applied");
  assert.equal(failed.clicks, 0);
  pass("값 적용 실패 시 확인 클릭 금지");

  const html = read("popup.html");
  assert.doesNotMatch(html, /invoice-stage[^>]*hidden/);
  const popup = read("popup.js");
  assert.doesNotMatch(popup, /AUTH_TAX_INVOICE|inspectPage|사업자번호 확인이 필요합니다/);
  assert.match(popup, /for \(const delay of \[700, 1300\]\)/);
  assert.match(popup, /인증 감지 실패는 분석을 막지 않는다[\s\S]{0,100}return "none"/);
  pass("전체 UI 상시 표시·서비스워커 인증 gate 제거·재시도 2회 제한");

  assert.match(read("popup.css"), /\.version\s*\{/);
  const background = read("background.js");
  assert.match(background, /adapter !== "generic"/);
  assert.match(background, /strategy = "generic_print"/);
  assert.match(background, /preferCSSPageSize: true,[\s\S]{0,80}scale: 0\.95/);
  pass("generic adapter·UI 스타일 유지 + 기존 printToPDF 옵션 유지");

  const printAdapters = read("print-adapters.js");
  assert.match(printAdapters, /smileedi\\\.com\$/);
  assert.match(printAdapters, /ecount\\\.com\$/);
  assert.match(printAdapters, /smartbill\\\.co\\\.kr\$/);
  assert.match(printAdapters, /hometax\\\.go\\\.kr\$/);
  assert.doesNotMatch(printAdapters, /drbill|freebill/i);
  assert.match(printAdapters, /좋은 ERP를 찾고 계신가요\?/);
  assert.match(printAdapters, /이카운트ERP 살펴보기/);
  assert.match(printAdapters, /state\.records[\s\S]{0,200}style[\s\S]{0,200}className/);
  assert.match(background, /finally \{[\s\S]*pageCall\(tabId, "restore"\)/);
  assert.match(printAdapters, /entry\.label === "인쇄" \|\| entry\.label === "첨부보기"/);
  assert.match(printAdapters, /startRestoreState\("hometax_controls"\)/);
  pass("기존 출력 adapter 격리 + eCount/HomeTax 임시 숨김 복원");

  assert.match(printAdapters, /invoiceEvidence[\s\S]*승인\\s\*번호[\s\S]*공급\\s\*받는\\s\*자/);
  assert.match(printAdapters, /prepareInvoiceOnly[\s\S]*smartbill/);
  assert.match(background, /smileedi_invoice_capture/);
  assert.match(background, /verifiedPrintTab\(tabId, adapter\)/);
  pass("SmileEDI 검증된 인쇄 문서 우선·캡처 fallback + SmartBill 본문 출력");

  const popupSource = read("popup.js");
  const popupHtml = read("popup.html");
  assert.match(popupHtml, /id="saveButton"[\s\S]*세금계산서 PDF 저장/);
  assert.doesNotMatch(popupHtml, /사이트 PDF 저장|현재 화면을 PDF로 만들기/);
  assert.match(popupSource, /saveButton\.addEventListener\("click", \(\) => savePdf\(\)\)/);
  assert.doesNotMatch(popupSource, /downloadSitePdf|locatePdfButtonInPage|clickPdfButtonInPage/);
  assert.match(popupSource, /PDF 저장을 시작했습니다/);
  pass("PDF 저장 버튼 하나로 통합 + 사이트별 출력은 background adapter에 위임");

  const filenameStart = background.indexOf("function safeFilenamePart");
  const filenameEnd = background.indexOf("async function detachQuietly", filenameStart);
  const filenameContext = {};
  vm.createContext(filenameContext);
  vm.runInContext(`${background.slice(filenameStart, filenameEnd)}\nthis.filenameTest = { buildFilename };`, filenameContext);
  assert.equal(
    filenameContext.filenameTest.buildFilename({ date: "20260825", supplier: "(주)테스트렌탈", item: "컬러복사기렌탈" }),
    "세금계산서(260825_(주)테스트렌탈_컬러복사기렌탈).pdf"
  );
  assert.equal(
    filenameContext.filenameTest.buildFilename({ date: "", supplier: "테스트청소", item: "후드목 및 덕트입구청소" }),
    "세금계산서(테스트청소_후드목 및 덕트입구청소).pdf"
  );
  assert.match(popupSource, /세금계산서\(\$\{details\.join\("_"\)\}\)\.pdf/);
  pass("괄호형 파일명 규칙을 미리보기와 실제 다운로드에 동일 적용");

  const renameStart = background.indexOf("const SITE_RENAME_TTL_MS");
  const renameEnd = background.indexOf("async function clearExpiredSiteRename", renameStart);
  const renameContext = { URL };
  vm.createContext(renameContext);
  vm.runInContext(`${background.slice(renameStart, renameEnd)}\nthis.renameTest = { SITE_RENAME_TTL_MS, matchesSitePendingRename };`, renameContext);
  const pending = { filename: "세금계산서.pdf", site: "smileedi", tabId: 7, expiresAt: 20_000 };
  assert.equal(renameContext.renameTest.SITE_RENAME_TTL_MS, 15_000);
  assert.equal(renameContext.renameTest.matchesSitePendingRename({ mime: "application/pdf", byExtensionId: "self" }, pending, "self", 10_000), false);
  assert.equal(renameContext.renameTest.matchesSitePendingRename({ mime: "application/pdf", byExtensionId: "other" }, pending, "self", 10_000), false);
  assert.equal(renameContext.renameTest.matchesSitePendingRename({ url: "data:application/pdf;base64,AA==" }, pending, "self", 10_000), false);
  assert.equal(renameContext.renameTest.matchesSitePendingRename({ filename: "invoice.pdf", referrer: "https://link.smileedi.com/a" }, pending, "self", 10_000), true);
  assert.equal(renameContext.renameTest.matchesSitePendingRename({ filename: "invoice.pdf", referrer: "https://www.smartbill.co.kr/a" }, pending, "self", 10_000), false);
  assert.equal(renameContext.renameTest.matchesSitePendingRename({ filename: "invoice.xml", mime: "application/xml", referrer: "https://link.smileedi.com/a" }, pending, "self", 10_000), false);
  assert.equal(renameContext.renameTest.matchesSitePendingRename({ filename: "invoice.pdf", referrer: "https://link.smileedi.com/a" }, pending, "self", 21_000), false);
  pass("사이트·PDF·확장 ID·15초 만료 조건으로 첫 다운로드 제한");
  assert.match(background, /if \(downloadItem\.byExtensionId\) return false;/);
  assert.match(background, /chrome\.storage\.session\.remove\(PENDING_SITE_RENAME_KEY\)/);
  const determiningStart = background.indexOf("chrome.downloads.onDeterminingFilename.addListener");
  const determiningSource = background.slice(determiningStart);
  assert.ok(
    determiningSource.indexOf("PENDING_RENAME_KEY") < determiningSource.indexOf("PENDING_SITE_RENAME_KEY"),
    "확장앱 자체 PDF 파일명 예약이 사이트 다운로드 예약보다 먼저 처리되어야 합니다."
  );
  pass("실제 저장 파일명에서 오래된 사이트 rename이 새 괄호형 이름을 덮어쓰지 않음");


  const pdfContext = { atob, btoa, console };
  vm.createContext(pdfContext);
  vm.runInContext(read("pdf-utils.js"), pdfContext);
  const smallPdf = "%PDF-1.4\n" + " ".repeat(1500) + "\n%%EOF\n";
  assert.equal(pdfContext.validatePdf(btoa(smallPdf), false), smallPdf.length);
  assert.throws(() => pdfContext.validatePdf(btoa(smallPdf), true), /세금계산서 내용을 PDF로 만들지 못했습니다/);
  const textPdf = "%PDF-1.4\nBT " + "x".repeat(1500) + " Tj ET\n%%EOF\n";
  assert.equal(pdfContext.validatePdf(btoa(textPdf), true), textPdf.length);
  pass("사이트 PDF 빈 문서 의심 차단 + generic 보수적 호환");

  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.version, "1.8.8");
  assert.deepEqual(manifest.permissions, ["activeTab", "debugger", "downloads", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["*://*.freebill.co.kr/*", "*://*.ecount.com/*", "*://*.etradebill.co.kr/*"]);
  pass("v1.8.8 버전 + FreeBill/eCount 유지 + eTradeBill 호스트 권한 추가");

  console.log("TOTAL", passed);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
