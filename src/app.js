import {
  CURRENCY_LABELS,
  CalculationError,
  calculateWorth,
  getCurrencyYearBounds,
} from "./calculator.js";

const DEFAULT_TARGET_YEAR = 2026;
const FORM_STORAGE_KEY = "worth-then:converter-form:v1";
const OLD_GBP_STORAGE_KEY = "worth-then:old-gbp-form:v1";
const OLD_GBP_MAX_SOURCE_YEAR = 1971;
const SHILLINGS_PER_POUND = 20;
const PENCE_PER_SHILLING = 12;
const PENCE_PER_POUND = SHILLINGS_PER_POUND * PENCE_PER_SHILLING;
const currencyOptions = ["GBP", "FRF", "EUR", "USD"];
const targetCurrencyOptions = ["KRW", "USD"];

const form = document.querySelector("#converter-form");
const oldGbpForm = document.querySelector("#old-gbp-form");
const sourceCurrencyInput = document.querySelector("#source-currency");
const amountInput = document.querySelector("#amount");
const sourceYearInput = document.querySelector("#source-year");
const targetYearInput = document.querySelector("#target-year");
const submitButton = document.querySelector("#submit-button");
const resultPanel = document.querySelector("#result-panel");
const statusText = document.querySelector("#status-text");
const oldGbpPoundsInput = document.querySelector("#old-gbp-pounds");
const oldGbpShillingsInput = document.querySelector("#old-gbp-shillings");
const oldGbpPenceInput = document.querySelector("#old-gbp-pence");
const oldGbpSourceYearInput = document.querySelector("#old-gbp-source-year");
const oldGbpTargetYearInput = document.querySelector("#old-gbp-target-year");
const oldGbpSubmitButton = document.querySelector("#old-gbp-submit-button");
const oldGbpResultPanel = document.querySelector("#old-gbp-result-panel");

let dataset = null;

init();

async function init() {
  setLoading(true);

  try {
    dataset = await loadDataset();
    populateCurrencyOptions();
    targetYearInput.value = String(DEFAULT_TARGET_YEAR);
    sourceYearInput.value = "1930";
    oldGbpTargetYearInput.value = String(DEFAULT_TARGET_YEAR);
    oldGbpSourceYearInput.value = "1930";
    restoreFormState();
    restoreOldGbpFormState();
    syncYearBounds();
    syncOldGbpYearBounds();
    formatAmountField();
    persistFormState();
    persistOldGbpFormState();
    setLoading(false);
    renderEmptyResult();
    renderOldGbpEmptyResult();
    form.addEventListener("submit", handleSubmit);
    oldGbpForm.addEventListener("submit", handleOldGbpSubmit);
    sourceCurrencyInput.addEventListener("change", handleSourceCurrencyChange);
    amountInput.addEventListener("input", handleAmountInput);
    amountInput.addEventListener("blur", handleAmountBlur);
    sourceYearInput.addEventListener("input", persistFormState);
    targetYearInput.addEventListener("input", persistFormState);
    [
      oldGbpPoundsInput,
      oldGbpShillingsInput,
      oldGbpPenceInput,
      oldGbpSourceYearInput,
      oldGbpTargetYearInput,
    ].forEach((input) => input.addEventListener("input", persistOldGbpFormState));
    targetCurrencyOptions.forEach((currency) => {
      const input = form.querySelector(`input[name="targetCurrency"][value="${currency}"]`);
      input?.addEventListener("change", persistFormState);

      const oldGbpInput = oldGbpForm.querySelector(
        `input[name="oldGbpTargetCurrency"][value="${currency}"]`,
      );
      oldGbpInput?.addEventListener("change", persistOldGbpFormState);
    });
  } catch (error) {
    setLoading(false);
    renderError("데이터를 불러오지 못했습니다. HTTP 서버에서 다시 열어주세요.");
    console.error(error);
  }
}

async function loadDataset() {
  const [priceIndexes, exchangeRates, sources] = await Promise.all([
    fetchJson("./data/price-indexes.json"),
    fetchJson("./data/exchange-rates.json"),
    fetchJson("./data/sources.json"),
  ]);

  return {
    priceIndexes,
    exchangeRates,
    sources,
  };
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}`);
  }

  return response.json();
}

function populateCurrencyOptions() {
  sourceCurrencyInput.replaceChildren(
    ...currencyOptions.map((currency) => {
      const option = document.createElement("option");
      option.value = currency;
      option.textContent = `${CURRENCY_LABELS[currency]} (${currency})`;
      return option;
    }),
  );
  sourceCurrencyInput.value = "GBP";
}

function syncYearBounds() {
  const bounds = getCurrencyYearBounds(sourceCurrencyInput.value, dataset.priceIndexes);
  if (!bounds) {
    return;
  }

  sourceYearInput.min = String(bounds.start);
  sourceYearInput.max = String(bounds.end);

  const currentSourceYear = Number(sourceYearInput.value);
  if (!Number.isFinite(currentSourceYear) || currentSourceYear < bounds.start) {
    sourceYearInput.value = String(bounds.start);
  }

  if (currentSourceYear > bounds.end) {
    sourceYearInput.value = String(bounds.end);
  }

  targetYearInput.min = "1960";
  targetYearInput.max = String(getMaxTargetYear(dataset.exchangeRates));

  const currentTargetYear = Number(targetYearInput.value);
  const minTargetYear = Number(targetYearInput.min);
  const maxTargetYear = Number(targetYearInput.max);

  if (!Number.isFinite(currentTargetYear) || currentTargetYear < minTargetYear) {
    targetYearInput.value = String(minTargetYear);
  }

  if (currentTargetYear > maxTargetYear) {
    targetYearInput.value = String(maxTargetYear);
  }
}

function syncOldGbpYearBounds() {
  const bounds = getCurrencyYearBounds("GBP", dataset.priceIndexes);
  if (!bounds) {
    return;
  }

  oldGbpSourceYearInput.min = String(bounds.start);
  oldGbpSourceYearInput.max = String(Math.min(bounds.end, OLD_GBP_MAX_SOURCE_YEAR));

  const currentSourceYear = Number(oldGbpSourceYearInput.value);
  const maxSourceYear = Number(oldGbpSourceYearInput.max);
  if (!Number.isFinite(currentSourceYear) || currentSourceYear < bounds.start) {
    oldGbpSourceYearInput.value = String(bounds.start);
  }

  if (currentSourceYear > maxSourceYear) {
    oldGbpSourceYearInput.value = String(maxSourceYear);
  }

  oldGbpTargetYearInput.min = "1960";
  oldGbpTargetYearInput.max = String(getMaxTargetYear(dataset.exchangeRates));

  const currentTargetYear = Number(oldGbpTargetYearInput.value);
  const minTargetYear = Number(oldGbpTargetYearInput.min);
  const maxTargetYear = Number(oldGbpTargetYearInput.max);

  if (!Number.isFinite(currentTargetYear) || currentTargetYear < minTargetYear) {
    oldGbpTargetYearInput.value = String(minTargetYear);
  }

  if (currentTargetYear > maxTargetYear) {
    oldGbpTargetYearInput.value = String(maxTargetYear);
  }
}

function getMaxTargetYear(exchangeRates) {
  return Math.max(
    ...Object.values(exchangeRates.rates).map((rate) => rate.yearRange.end ?? 0),
  );
}

function handleSubmit(event) {
  event.preventDefault();
  persistFormState();

  try {
    const result = calculateWorth(
      {
        amount: amountInput.value,
        sourceCurrency: sourceCurrencyInput.value,
        sourceYear: sourceYearInput.value,
        targetYear: targetYearInput.value,
        targetCurrency: getTargetCurrency(),
      },
      dataset,
    );
    renderResult(result);
  } catch (error) {
    if (error instanceof CalculationError) {
      renderError(error.message);
      return;
    }

    renderError("계산 중 문제가 생겼습니다.");
    console.error(error);
  }
}

function handleOldGbpSubmit(event) {
  event.preventDefault();
  persistOldGbpFormState();

  try {
    const amountParts = getOldGbpAmountParts();
    assertOldGbpAmountParts(amountParts);
    assertOldGbpSourceYear(oldGbpSourceYearInput.value);
    assertOldGbpTargetYear(oldGbpTargetYearInput.value);

    const decimalPounds = oldGbpPartsToPounds(amountParts);
    const result = calculateWorth(
      {
        amount: decimalPounds,
        sourceCurrency: "GBP",
        sourceYear: oldGbpSourceYearInput.value,
        targetYear: oldGbpTargetYearInput.value,
        targetCurrency: getOldGbpTargetCurrency(),
      },
      dataset,
    );
    renderOldGbpResult(result, amountParts);
  } catch (error) {
    if (error instanceof CalculationError) {
      renderOldGbpError(error.message);
      return;
    }

    renderOldGbpError("계산 중 문제가 생겼습니다.");
    console.error(error);
  }
}

function getTargetCurrency() {
  return form.elements.targetCurrency.value;
}

function getOldGbpTargetCurrency() {
  return oldGbpForm.elements.oldGbpTargetCurrency.value;
}

function getOldGbpAmountParts() {
  return {
    pounds: parseOldGbpAmountPart(oldGbpPoundsInput.value),
    shillings: parseOldGbpAmountPart(oldGbpShillingsInput.value),
    pence: parseOldGbpAmountPart(oldGbpPenceInput.value),
  };
}

function parseOldGbpAmountPart(value) {
  const normalized = String(value).replaceAll(",", "").trim();
  if (normalized === "") {
    return 0;
  }

  return Number(normalized);
}

function assertOldGbpAmountParts(amountParts) {
  const hasInvalidPart = Object.values(amountParts).some(
    (part) => !Number.isFinite(part) || part < 0,
  );
  if (hasInvalidPart) {
    throw new CalculationError("파운드, 실링, 펜스는 0 이상의 숫자로 입력해주세요.");
  }

  if (oldGbpPartsToPounds(amountParts) <= 0) {
    throw new CalculationError("구화폐 금액을 입력해주세요.");
  }
}

function assertOldGbpSourceYear(value) {
  if (String(value).trim() === "") {
    throw new CalculationError("기준 연도를 숫자로 입력해주세요.");
  }

  const sourceYear = Number(value);
  if (!Number.isInteger(sourceYear)) {
    throw new CalculationError("기준 연도를 숫자로 입력해주세요.");
  }

  const minSourceYear = Number(oldGbpSourceYearInput.min);
  if (Number.isFinite(minSourceYear) && sourceYear < minSourceYear) {
    throw new CalculationError(
      `기준 연도는 ${minSourceYear}년부터 ${OLD_GBP_MAX_SOURCE_YEAR}년 사이로 입력해주세요.`,
    );
  }

  if (sourceYear > OLD_GBP_MAX_SOURCE_YEAR) {
    throw new CalculationError("구 영국 화폐는 1971년 십진화 이전 표기 기준으로 계산해주세요.");
  }
}

function assertOldGbpTargetYear(value) {
  if (String(value).trim() === "") {
    throw new CalculationError("목표 연도를 숫자로 입력해주세요.");
  }

  const targetYear = Number(value);
  if (!Number.isInteger(targetYear)) {
    throw new CalculationError("목표 연도를 숫자로 입력해주세요.");
  }

  const minTargetYear = Number(oldGbpTargetYearInput.min);
  const maxTargetYear = Number(oldGbpTargetYearInput.max);

  if (
    Number.isFinite(minTargetYear)
    && Number.isFinite(maxTargetYear)
    && (targetYear < minTargetYear || targetYear > maxTargetYear)
  ) {
    throw new CalculationError(
      `목표 연도는 ${minTargetYear}년부터 ${maxTargetYear}년 사이로 입력해주세요.`,
    );
  }
}

function oldGbpPartsToPounds({ pounds, shillings, pence }) {
  return pounds + shillings / SHILLINGS_PER_POUND + pence / PENCE_PER_POUND;
}

function handleSourceCurrencyChange() {
  syncYearBounds();
  persistFormState();
}

function handleAmountInput() {
  formatAmountField();
  persistFormState();
}

function handleAmountBlur() {
  formatAmountField();
  persistFormState();
}

function renderEmptyResult() {
  resultPanel.className = "result-panel is-empty";
  resultPanel.innerHTML = `
    <p class="result-label">계산 결과</p>
    <p class="empty-message">값을 입력하면 여기에 표시됩니다.</p>
  `;
}

function renderOldGbpEmptyResult() {
  oldGbpResultPanel.className = "result-panel is-empty";
  oldGbpResultPanel.innerHTML = `
    <p class="result-label">구화폐 계산 결과</p>
    <p class="empty-message">파운드, 실링, 펜스를 입력하면 여기에 표시됩니다.</p>
  `;
}

function renderResult(result) {
  const formattedResult = formatMoney(result.result, result.targetCurrency);
  const sourceAmount = formatPlainAmount(result.amount, result.sourceCurrency);
  const sourceLabel = CURRENCY_LABELS[result.sourceCurrency];
  const targetLabel = CURRENCY_LABELS[result.targetCurrency];
  const indexYears = `${result.used.sourceIndexYear} → ${result.used.targetIndexYear}`;
  const exchangeYears = formatExchangeYears(result.used.exchangeRateYears);
  const notes = result.notes.length
    ? result.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")
    : "<li>확정 연간 데이터만 사용했습니다.</li>";

  resultPanel.className = "result-panel";
  resultPanel.innerHTML = `
    <p class="result-label">약 ${targetLabel}</p>
    <output class="result-value">${formattedResult}</output>
    <p class="result-context">
      ${result.sourceYear}년 ${sourceLabel} ${sourceAmount}의 ${result.targetYear}년 기준 추정값입니다.
    </p>
    <dl class="result-facts">
      <div>
        <dt>물가지수</dt>
        <dd>${indexYears}</dd>
      </div>
      <div>
        <dt>환율</dt>
        <dd>${exchangeYears}</dd>
      </div>
    </dl>
    <details class="result-details">
      <summary>계산 근거</summary>
      <ul>${notes}</ul>
    </details>
  `;
}

function renderOldGbpResult(result, amountParts) {
  const formattedResult = formatMoney(result.result, result.targetCurrency);
  const targetLabel = CURRENCY_LABELS[result.targetCurrency];
  const oldAmount = formatOldGbpAmount(amountParts);
  const decimalPounds = formatDecimalPounds(result.amount);
  const indexYears = `${result.used.sourceIndexYear} → ${result.used.targetIndexYear}`;
  const exchangeYears = formatExchangeYears(result.used.exchangeRateYears);
  const notes = buildOldGbpNotes(result)
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join("");

  oldGbpResultPanel.className = "result-panel";
  oldGbpResultPanel.innerHTML = `
    <p class="result-label">약 ${targetLabel}</p>
    <output class="result-value">${formattedResult}</output>
    <p class="result-context">
      ${result.sourceYear}년 영국 구화폐 ${oldAmount} (${decimalPounds})의 ${result.targetYear}년 기준 추정값입니다.
    </p>
    <dl class="result-facts">
      <div>
        <dt>구화폐 기준</dt>
        <dd>£1 = 20s = 240d</dd>
      </div>
      <div>
        <dt>물가지수</dt>
        <dd>${indexYears}</dd>
      </div>
      <div>
        <dt>환율</dt>
        <dd>${exchangeYears}</dd>
      </div>
    </dl>
    <details class="result-details">
      <summary>계산 근거</summary>
      <ul>${notes}</ul>
    </details>
  `;
}

function renderError(message) {
  resultPanel.className = "result-panel is-error";
  resultPanel.innerHTML = `
    <p class="result-label">계산 결과</p>
    <p class="error-message">${escapeHtml(message)}</p>
  `;
}

function renderOldGbpError(message) {
  oldGbpResultPanel.className = "result-panel is-error";
  oldGbpResultPanel.innerHTML = `
    <p class="result-label">구화폐 계산 결과</p>
    <p class="error-message">${escapeHtml(message)}</p>
  `;
}

function formatExchangeYears(exchangeRateYears) {
  const entries = Object.entries(exchangeRateYears);
  if (entries.length === 0) {
    return "불필요";
  }

  return entries
    .map(([currency, rate]) => `${currency} ${rate.year}`)
    .join(", ");
}

function buildOldGbpNotes(result) {
  const notes = [
    "실링과 펜스는 1파운드 = 20실링, 1실링 = 12펜스 기준으로 십진 파운드에 합산했습니다.",
    ...result.notes,
  ];

  if (result.sourceYear === OLD_GBP_MAX_SOURCE_YEAR) {
    notes.push("1971년은 영국 십진화 전후가 섞이는 해라 구화폐 표기일 때의 참고값으로 보세요.");
  }

  return [...new Set(notes)];
}

function formatMoney(value, currency) {
  const options = {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "KRW" || Math.abs(value) >= 100 ? 0 : 2,
  };

  return new Intl.NumberFormat("ko-KR", options).format(value);
}

function formatPlainAmount(value, currency) {
  const maximumFractionDigits = Number.isInteger(value) ? 0 : 2;
  const formatted = new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits,
  }).format(value);

  return `${formatted} ${currency}`;
}

function formatDecimalPounds(value) {
  const formatted = new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 4,
  }).format(value);

  return `${formatted} GBP`;
}

function formatOldGbpAmount({ pounds, shillings, pence }) {
  const parts = [];

  if (pounds > 0) {
    parts.push(`£${formatCompactNumber(pounds)}`);
  }

  if (shillings > 0) {
    parts.push(`${formatCompactNumber(shillings)}s`);
  }

  if (pence > 0 || parts.length === 0) {
    parts.push(`${formatCompactNumber(pence)}d`);
  }

  return parts.join(" ");
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 2,
  }).format(value);
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  oldGbpSubmitButton.disabled = isLoading;
  statusText.textContent = isLoading ? "데이터 로딩 중" : "";
}

function restoreFormState() {
  const state = readStoredFormState();
  if (!state) {
    return;
  }

  if (currencyOptions.includes(state.sourceCurrency)) {
    sourceCurrencyInput.value = state.sourceCurrency;
  }

  if (typeof state.amount === "string") {
    amountInput.value = state.amount;
  }

  if (isYearValue(state.sourceYear)) {
    sourceYearInput.value = state.sourceYear;
  }

  if (isYearValue(state.targetYear)) {
    targetYearInput.value = state.targetYear;
  }

  if (targetCurrencyOptions.includes(state.targetCurrency)) {
    setTargetCurrency(state.targetCurrency);
  }
}

function restoreOldGbpFormState() {
  const state = readStoredOldGbpFormState();
  if (!state) {
    return;
  }

  if (typeof state.pounds === "string") {
    oldGbpPoundsInput.value = state.pounds;
  }

  if (typeof state.shillings === "string") {
    oldGbpShillingsInput.value = state.shillings;
  }

  if (typeof state.pence === "string") {
    oldGbpPenceInput.value = state.pence;
  }

  if (isYearValue(state.sourceYear)) {
    oldGbpSourceYearInput.value = state.sourceYear;
  }

  if (isYearValue(state.targetYear)) {
    oldGbpTargetYearInput.value = state.targetYear;
  }

  if (targetCurrencyOptions.includes(state.targetCurrency)) {
    setOldGbpTargetCurrency(state.targetCurrency);
  }
}

function readStoredFormState() {
  try {
    const storedValue = localStorage.getItem(FORM_STORAGE_KEY);
    return storedValue ? JSON.parse(storedValue) : null;
  } catch {
    return null;
  }
}

function readStoredOldGbpFormState() {
  try {
    const storedValue = localStorage.getItem(OLD_GBP_STORAGE_KEY);
    return storedValue ? JSON.parse(storedValue) : null;
  } catch {
    return null;
  }
}

function persistFormState() {
  try {
    localStorage.setItem(
      FORM_STORAGE_KEY,
      JSON.stringify({
        sourceCurrency: sourceCurrencyInput.value,
        amount: amountInput.value,
        sourceYear: sourceYearInput.value,
        targetYear: targetYearInput.value,
        targetCurrency: getTargetCurrency(),
      }),
    );
  } catch {
    // Browsers can disable storage in private or restricted contexts.
  }
}

function persistOldGbpFormState() {
  try {
    localStorage.setItem(
      OLD_GBP_STORAGE_KEY,
      JSON.stringify({
        pounds: oldGbpPoundsInput.value,
        shillings: oldGbpShillingsInput.value,
        pence: oldGbpPenceInput.value,
        sourceYear: oldGbpSourceYearInput.value,
        targetYear: oldGbpTargetYearInput.value,
        targetCurrency: getOldGbpTargetCurrency(),
      }),
    );
  } catch {
    // Browsers can disable storage in private or restricted contexts.
  }
}

function setTargetCurrency(currency) {
  const input = form.querySelector(`input[name="targetCurrency"][value="${currency}"]`);
  if (input) {
    input.checked = true;
  }
}

function setOldGbpTargetCurrency(currency) {
  const input = oldGbpForm.querySelector(`input[name="oldGbpTargetCurrency"][value="${currency}"]`);
  if (input) {
    input.checked = true;
  }
}

function isYearValue(value) {
  return /^\d{1,4}$/.test(String(value));
}

function formatAmountField() {
  const cursor = amountInput.selectionStart ?? amountInput.value.length;
  const preservedCount = countAmountCharacters(amountInput.value.slice(0, cursor));
  const formattedValue = formatAmountInput(amountInput.value);

  amountInput.value = formattedValue;

  const nextCursor = getCursorForAmountCharacterCount(formattedValue, preservedCount);
  amountInput.setSelectionRange(nextCursor, nextCursor);
}

function formatAmountInput(value) {
  const sanitizedValue = sanitizeAmountInput(value);
  if (sanitizedValue === "") {
    return "";
  }

  const hasDecimalPoint = sanitizedValue.includes(".");
  const [rawIntegerPart, rawFractionPart = ""] = sanitizedValue.split(".");
  const integerPart = rawIntegerPart.replace(/^0+(?=\d)/, "") || "0";
  const formattedIntegerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  if (hasDecimalPoint) {
    return `${formattedIntegerPart}.${rawFractionPart}`;
  }

  return formattedIntegerPart;
}

function sanitizeAmountInput(value) {
  let sanitized = "";
  let hasDecimalPoint = false;

  for (const character of String(value)) {
    if (/\d/.test(character)) {
      sanitized += character;
      continue;
    }

    if (character === "." && !hasDecimalPoint) {
      sanitized += character;
      hasDecimalPoint = true;
    }
  }

  return sanitized;
}

function countAmountCharacters(value) {
  return sanitizeAmountInput(value).length;
}

function getCursorForAmountCharacterCount(value, targetCount) {
  if (targetCount <= 0) {
    return 0;
  }

  let currentCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (/[\d.]/.test(value[index])) {
      currentCount += 1;
    }

    if (currentCount >= targetCount) {
      return index + 1;
    }
  }

  return value.length;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
