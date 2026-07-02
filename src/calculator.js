export const CURRENCY_LABELS = {
  GBP: "영국 파운드",
  FRF: "프랑스 프랑",
  EUR: "유럽 유로",
  USD: "미국 달러",
  KRW: "원화",
};

const TARGET_CURRENCIES = new Set(["KRW", "USD"]);
const FRF_TO_EUR = 6.55957;
const OLD_FRANC_TO_NEW_FRANC = 100;

export function calculateWorth(input, dataset) {
  const amount = Number(input.amount);
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

  const start = index.usableFromYear ?? index.yearRange.start;
  let end = index.yearRange.end;

  if (currency === "FRF") {
    end = Math.min(end, 1998);
  }

  return {
    start,
    end,
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
  if (priceIndex.usableFromYear && sourceYear < priceIndex.usableFromYear) {
    throw new CalculationError(
      `${CURRENCY_LABELS[currency]}는 ${priceIndex.usableFromYear}년 이후 금액만 계산할 수 있습니다.`,
    );
  }

  if (currency === "FRF" && sourceYear > 1998) {
    throw new CalculationError("프랑스 프랑은 1998년 이전 금액으로 계산해주세요.");
  }
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
  if (sourceCurrency !== "FRF") {
    return {
      factor: 1,
      notes: [],
    };
  }

  const notes = [];
  let factor = 1;

  if (sourceYear < 1960 && targetIndexYear >= 1960) {
    factor /= OLD_FRANC_TO_NEW_FRANC;
    notes.push("1960년 신프랑 전환율 1 신프랑 = 100 구프랑을 반영했습니다.");
  }

  if (targetIndexYear >= 1999) {
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

  if (targetCurrency === "KRW") {
    notes.push("원화 결과는 목표 연도 환율을 거친 대략값입니다.");
  }

  return [...new Set(notes)];
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

export class CalculationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CalculationError";
  }
}
