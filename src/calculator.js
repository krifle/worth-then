export const CURRENCY_LABELS = {
  GBP: "영국 파운드",
  FRF: "프랑스 프랑",
  EUR: "유럽 유로",
  USD: "미국 달러",
  RUB_IMP: "제정 러시아 루블",
  SUR: "소련 루블",
  RUR: "러시아 구루블",
  RUB: "러시아 루블",
  KRW: "원화",
};

const TARGET_CURRENCIES = new Set(["KRW", "USD"]);
const HISTORICAL_RUBLE_SOURCE_CURRENCIES = new Set(["RUB_IMP", "SUR"]);
const FRF_TO_EUR = 6.55957;
const OLD_FRANC_TO_NEW_FRANC = 100;
const OLD_RUBLE_TO_NEW_RUBLE = 1000;

export function calculateWorth(input, dataset) {
  const amount = parseAmount(input.amount);
  const sourceYear = toInteger(input.sourceYear);
  const targetYear = toInteger(input.targetYear);
  const sourceCurrency = input.sourceCurrency;
  const targetCurrency = input.targetCurrency;

  assertValidInput({
    amount,
    sourceYear,
    targetYear,
    sourceCurrency,
    targetCurrency,
    dataset,
  });

  const priceIndex = dataset.priceIndexes.indexes[sourceCurrency];
  assertCurrencyYear(sourceCurrency, sourceYear, priceIndex);
  assertTargetYear(sourceCurrency, targetYear, priceIndex);

  const sourceIndex = findYearAtOrBefore(priceIndex.years, sourceYear);
  const targetIndex = findYearAtOrBefore(priceIndex.years, targetYear);
  const unitConversion = getUnitConversion(sourceCurrency, sourceYear, targetIndex.year);
  const localCurrency = getLocalCurrency(sourceCurrency, targetIndex.year);

  const purchasingPowerRatio = targetIndex.value / sourceIndex.value;
  const localAmount =
    amount * purchasingPowerRatio * unitConversion.factor;

  const conversion = convertLocalToTarget({
    amount: localAmount,
    localCurrency,
    targetCurrency,
    targetYear,
    exchangeRates: dataset.exchangeRates.rates,
  });

  return {
    result: conversion.amount,
    targetCurrency,
    sourceCurrency,
    sourceYear,
    targetYear,
    amount,
    localAmount,
    localCurrency,
    used: {
      sourceIndexYear: sourceIndex.year,
      targetIndexYear: targetIndex.year,
      exchangeRateYears: conversion.exchangeRateYears,
    },
    notes: buildNotes({
      sourceCurrency,
      targetCurrency,
      sourceYear,
      targetYear,
      sourceIndex,
      targetIndex,
      priceIndex,
      conversion,
      unitConversion,
      localCurrency,
    }),
  };
}

export function getCurrencyYearBounds(currency, priceIndexes) {
  const index = priceIndexes.indexes[currency];
  if (!index) {
    return null;
  }

  const bounds = getSourceYearBounds(currency, index);

  return {
    start: bounds.start,
    end: bounds.end,
  };
}

function assertValidInput({
  amount,
  sourceYear,
  targetYear,
  sourceCurrency,
  targetCurrency,
  dataset,
}) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CalculationError("금액은 0보다 큰 숫자로 입력해주세요.");
  }

  if (!Number.isInteger(sourceYear)) {
    throw new CalculationError("기준 연도를 숫자로 입력해주세요.");
  }

  if (!Number.isInteger(targetYear)) {
    throw new CalculationError("목표 연도를 숫자로 입력해주세요.");
  }

  if (!dataset.priceIndexes.indexes[sourceCurrency]) {
    throw new CalculationError("지원하지 않는 대상 화폐입니다.");
  }

  if (!TARGET_CURRENCIES.has(targetCurrency)) {
    throw new CalculationError("지원하지 않는 목표 화폐입니다.");
  }
}

function assertCurrencyYear(currency, sourceYear, priceIndex) {
  const bounds = getSourceYearBounds(currency, priceIndex);

  if (Number.isFinite(bounds.start) && sourceYear < bounds.start) {
    throw new CalculationError(
      `${CURRENCY_LABELS[currency]} 금액은 ${bounds.start}년 이후만 계산할 수 있습니다.`,
    );
  }

  if (Number.isFinite(bounds.end) && sourceYear > bounds.end) {
    throw new CalculationError(
      `${CURRENCY_LABELS[currency]} 금액은 ${bounds.end}년 이전으로 계산해주세요.`,
    );
  }
}

function assertTargetYear(currency, targetYear, priceIndex) {
  const bounds = priceIndex.targetYearRange;
  if (!bounds) {
    return;
  }

  if (Number.isFinite(bounds.start) && targetYear < bounds.start) {
    throw new CalculationError(
      `${CURRENCY_LABELS[currency]} 금액은 목표 연도 ${bounds.start}년 이후로만 계산할 수 있습니다.`,
    );
  }

  if (Number.isFinite(bounds.end) && targetYear > bounds.end) {
    throw new CalculationError(
      `${CURRENCY_LABELS[currency]} 금액은 목표 연도 ${bounds.end}년 이전으로 계산해주세요.`,
    );
  }
}

function getSourceYearBounds(currency, priceIndex) {
  const legacyEndYear = currency === "FRF"
    ? Math.min(priceIndex.yearRange.end, 1998)
    : priceIndex.yearRange.end;

  return {
    start:
      priceIndex.sourceYearRange?.start
      ?? priceIndex.usableFromYear
      ?? priceIndex.yearRange.start,
    end: priceIndex.sourceYearRange?.end ?? legacyEndYear,
  };
}

function findYearAtOrBefore(years, requestedYear) {
  if (Object.hasOwn(years, String(requestedYear))) {
    return {
      requestedYear,
      year: requestedYear,
      value: years[String(requestedYear)],
      exact: true,
    };
  }

  const availableYear = Object.keys(years)
    .map(Number)
    .filter((year) => year <= requestedYear)
    .sort((a, b) => b - a)[0];

  if (!availableYear) {
    const firstYear = Object.keys(years).map(Number).sort((a, b) => a - b)[0];
    throw new CalculationError(`${requestedYear}년 데이터가 없습니다. 사용 가능한 첫 연도는 ${firstYear}년입니다.`);
  }

  return {
    requestedYear,
    year: availableYear,
    value: years[String(availableYear)],
    exact: false,
  };
}

function getLocalCurrency(sourceCurrency, targetIndexYear) {
  if (HISTORICAL_RUBLE_SOURCE_CURRENCIES.has(sourceCurrency)) {
    return "USD";
  }

  if (sourceCurrency === "RUR") {
    return targetIndexYear >= 1998 ? "RUB" : "RUR";
  }

  if (sourceCurrency !== "FRF") {
    return sourceCurrency;
  }

  if (targetIndexYear >= 1999) {
    return "EUR";
  }

  if (targetIndexYear >= 1960) {
    return "FRF";
  }

  return "FRF_OLD";
}

function getUnitConversion(sourceCurrency, sourceYear, targetIndexYear) {
  if (sourceCurrency !== "FRF" && sourceCurrency !== "RUR") {
    return {
      factor: 1,
      notes: [],
    };
  }

  const notes = [];
  let factor = 1;

  if (sourceCurrency === "RUR" && targetIndexYear >= 1998) {
    factor /= OLD_RUBLE_TO_NEW_RUBLE;
    notes.push("1998년 러시아 화폐개혁 전환율 1 RUB = 1,000 RUR을 반영했습니다.");
  }

  if (sourceCurrency === "FRF" && sourceYear < 1960 && targetIndexYear >= 1960) {
    factor /= OLD_FRANC_TO_NEW_FRANC;
    notes.push("1960년 신프랑 전환율 1 신프랑 = 100 구프랑을 반영했습니다.");
  }

  if (sourceCurrency === "FRF" && targetIndexYear >= 1999) {
    factor /= FRF_TO_EUR;
    notes.push("프랑-유로 공식 고정 전환율 1 EUR = 6.55957 FRF를 반영했습니다.");
  }

  return {
    factor,
    notes,
  };
}

function convertLocalToTarget({
  amount,
  localCurrency,
  targetCurrency,
  targetYear,
  exchangeRates,
}) {
  if (localCurrency === "FRF_OLD") {
    throw new CalculationError("1960년 이전 프랑 환율 데이터가 없어 목표 화폐로 변환할 수 없습니다.");
  }

  const exchangeRateYears = {};
  const notes = [];

  if (localCurrency === targetCurrency) {
    return {
      amount,
      exchangeRateYears,
      notes,
    };
  }

  let usdAmount = amount;

  if (localCurrency !== "USD") {
    const rate = findExchangeRate(exchangeRates, localCurrency, targetYear);
    exchangeRateYears[localCurrency] = rate;
    usdAmount = amount / rate.value;
  }

  if (targetCurrency === "USD") {
    return {
      amount: usdAmount,
      exchangeRateYears,
      notes,
    };
  }

  const targetRate = findExchangeRate(exchangeRates, targetCurrency, targetYear);
  exchangeRateYears[targetCurrency] = targetRate;

  return {
    amount: usdAmount * targetRate.value,
    exchangeRateYears,
    notes,
  };
}

function findExchangeRate(exchangeRates, currency, requestedYear) {
  const rate = exchangeRates[currency];
  if (!rate) {
    throw new CalculationError(`${CURRENCY_LABELS[currency] ?? currency} 환율 데이터가 없습니다.`);
  }

  const selectedRate = findYearAtOrBefore(rate.years, requestedYear);
  return {
    ...selectedRate,
    provisional: Boolean(rate.provisionalYears?.[String(selectedRate.year)]),
  };
}

function buildNotes({
  sourceCurrency,
  targetCurrency,
  sourceYear,
  targetYear,
  sourceIndex,
  targetIndex,
  priceIndex,
  conversion,
  unitConversion,
  localCurrency,
}) {
  const notes = [];

  if (!sourceIndex.exact) {
    notes.push(`${sourceYear}년 물가지수가 없어 ${sourceIndex.year}년 값을 사용했습니다.`);
  }

  if (!targetIndex.exact) {
    notes.push(`${targetYear}년 물가지수가 없어 ${targetIndex.year}년 값을 사용했습니다.`);
  }

  if (priceIndex.provisionalYears?.[String(sourceIndex.year)]) {
    notes.push(`${sourceIndex.year}년 물가지수는 확정 연간값이 아닙니다.`);
  }

  if (priceIndex.provisionalYears?.[String(targetIndex.year)]) {
    notes.push(`${targetIndex.year}년 물가지수는 확정 연간값이 아닙니다.`);
  }

  for (const note of unitConversion.notes) {
    notes.push(note);
  }

  for (const [currency, rate] of Object.entries(conversion.exchangeRateYears)) {
    if (!rate.exact) {
      notes.push(`${targetYear}년 ${CURRENCY_LABELS[currency]} 환율이 없어 ${rate.year}년 값을 사용했습니다.`);
    }

    if (rate.provisional) {
      notes.push(`${rate.year}년 ${CURRENCY_LABELS[currency]} 환율은 확정 연평균이 아닙니다.`);
    }
  }

  if (sourceCurrency === "FRF" && localCurrency === "EUR") {
    notes.push("프랑 금액은 프랑스 내 구매력으로 보정한 뒤 유로 단위로 넘겨 환산했습니다.");
  }

  if (sourceCurrency === "RUR" && localCurrency === "RUB") {
    notes.push("러시아 구루블 금액은 러시아 CPI로 보정한 뒤 현행 루블 단위로 넘겨 환산했습니다.");
  }

  if (HISTORICAL_RUBLE_SOURCE_CURRENCIES.has(sourceCurrency)) {
    notes.push("역사 루블 금액은 Historicalstatistics.org의 시험판 장기 변환기를 사용한 매우 대략적 추정입니다.");
    notes.push("스웨덴 소비재 구매력 비교를 거쳐 목표 연도 미국 달러 감각으로 먼저 환산했습니다.");
  }

  if (sourceCurrency === "RUR" || sourceCurrency === "RUB") {
    notes.push("러시아 루블 결과는 World Bank CPI와 공식 환율 기반의 대략값입니다.");
  }

  if (targetCurrency === "KRW") {
    notes.push("원화 결과는 목표 연도 환율을 거친 대략값입니다.");
  }

  return [...new Set(notes)];
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function parseAmount(value) {
  if (typeof value === "number") {
    return value;
  }

  const normalized = String(value).replaceAll(",", "").trim();
  if (normalized === "") {
    return Number.NaN;
  }

  return Number(normalized);
}

export class CalculationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CalculationError";
  }
}
