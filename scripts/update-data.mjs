#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const dataDir = join(rootDir, "data");
const generatedAt = new Date().toISOString();
const currentYear = new Date().getUTCFullYear();
const today = generatedAt.slice(0, 10);

const urls = {
  boeInflation:
    "https://www.bankofengland.co.uk/monetary-policy/inflation/inflation-calculator",
  onsD7bt:
    "https://www.ons.gov.uk/generator?uri=/economy/inflationandpriceindices/timeseries/d7bt/mm23&format=csv",
  inseeFrancEuro:
    "https://bdm.insee.fr/series/011813530/csv?revision=avecrevisions",
  blsPublicApi: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
  eurostatHicpAnnual:
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_aind?format=JSON&lang=en&freq=A&unit=INX_A_AVG&coicop=CP00&geo=EA",
  worldBankExchange:
    "https://api.worldbank.org/v2/country/GBR;FRA;USA;KOR;EMU;RUS/indicator/PA.NUS.FCRF?format=json&per_page=20000",
  worldBankRussiaCpi:
    "https://api.worldbank.org/v2/country/RUS/indicator/FP.CPI.TOTL?format=json&per_page=20000",
  historicalCurrencyConverter:
    "https://www.historicalstatistics.org/Currencyconverter.html",
};

const sourceIds = {
  boe: "bank-of-england-inflation-calculator",
  ons: "ons-cpi-d7bt",
  insee: "insee-franc-euro-purchasing-power",
  bls: "bls-cpi-u-cuur0000sa0",
  eurostat: "eurostat-hicp-annual-euro-area",
  worldBankExchange: "world-bank-official-exchange-rate",
  worldBankRussiaCpi: "world-bank-russia-cpi",
  ecb: "ecb-euro-reference-rates",
  historicalCurrencyConverter: "historicalstatistics-currency-converter",
};

const HISTORICAL_CONSUMER_COLUMN = 0;
const HISTORICAL_RUSSIAN_RUBLE_COLUMN = 37;
const HISTORICAL_USD_COLUMN = 45;

async function main() {
  await mkdir(dataDir, { recursive: true });

  console.log("Fetching price indexes...");
  const [gbp, frf, eur, usd, rub, historicalCurrency] = await Promise.all([
    fetchGbpPriceIndex(),
    fetchFranceFrancPriceIndex(),
    fetchEuroPriceIndex(),
    fetchUsdPriceIndex(),
    fetchRussiaPriceIndex(),
    fetchHistoricalCurrencyConverter(),
  ]);

  console.log("Fetching exchange rates...");
  const exchangeRates = await fetchExchangeRates();

  await writeJson(
    "price-indexes.json",
    buildPriceIndexes(gbp, frf, eur, usd, rub, historicalCurrency),
  );
  await writeJson("exchange-rates.json", exchangeRates);
  await writeJson("sources.json", buildSources(exchangeRates));

  console.log("Generated data files in ./data");
}

async function fetchGbpPriceIndex() {
  const [boeHtml, onsCsv] = await Promise.all([
    fetchText(urls.boeInflation),
    fetchText(urls.onsD7bt),
  ]);

  const { years, provisionalYears } = parseBoeInflationData(boeHtml);
  const onsAnnual = parseOnsD7btAnnual(onsCsv);

  for (const [year, value] of Object.entries(onsAnnual.years)) {
    const numericYear = Number(year);
    if (numericYear > 2024) {
      years[year] = value;
      delete provisionalYears[year];
    }
  }

  return {
    years: sortYearValues(years),
    provisionalYears,
    metadata: {
      onsReleaseDate: onsAnnual.releaseDate,
    },
  };
}

function parseBoeInflationData(html) {
  const match = html.match(/window\.boeInflationData\s*=\s*\[(.*?)\]\s*;/s);
  if (!match) {
    throw new Error("Could not find window.boeInflationData on Bank of England page.");
  }

  const years = {};
  const monthlyByYear = {};
  const entryPattern =
    /\{\s*year:\s*"([^"]+)",\s*value:\s*([0-9]+(?:\.[0-9]+)?)\s*\}/g;
  let entry;

  while ((entry = entryPattern.exec(match[1])) !== null) {
    const [, label, rawValue] = entry;
    const value = toNumber(rawValue);

    if (/^\d{4}$/.test(label)) {
      years[label] = value;
      continue;
    }

    const monthMatch = label.match(/^([A-Z][a-z]{2})\s+(\d{2})$/);
    if (monthMatch) {
      const year = Number(`20${monthMatch[2]}`);
      monthlyByYear[year] ??= [];
      monthlyByYear[year].push({
        label,
        month: monthMatch[1],
        value,
      });
    }
  }

  const provisionalYears = {};
  for (const [year, records] of Object.entries(monthlyByYear)) {
    const numericYear = Number(year);
    const latest = records.at(-1);
    if (numericYear >= 2025 && latest && !years[year]) {
      years[year] = latest.value;
      provisionalYears[year] = {
        kind: "latest-month",
        sourceId: sourceIds.boe,
        label: latest.label,
        note:
          "Latest monthly index from the Bank of England calculator; not a complete annual average.",
      };
    }
  }

  return {
    years,
    provisionalYears,
  };
}

function parseOnsD7btAnnual(csvText) {
  const rows = parseDelimitedRows(csvText, ",");
  const years = {};
  let releaseDate = null;

  for (const row of rows) {
    if (row[0] === "Release date") {
      releaseDate = row[1] ?? null;
    }

    if (/^\d{4}$/.test(row[0] ?? "") && isFiniteNumber(row[1])) {
      years[row[0]] = toNumber(row[1]);
    }
  }

  return {
    years: sortYearValues(years),
    releaseDate,
  };
}

async function fetchFranceFrancPriceIndex() {
  const tempDir = await mkdtemp(join(tmpdir(), "worth-then-insee-"));
  const zipPath = join(tempDir, "insee-011813530.zip");

  try {
    const bytes = await fetchBytes(urls.inseeFrancEuro);
    await writeFile(zipPath, bytes);

    const { stdout: fileList } = await execFileAsync("unzip", ["-Z1", zipPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const valuesFile = fileList
      .split(/\r?\n/)
      .find((name) => name.endsWith("valeurs_annuelles.csv"));

    if (!valuesFile) {
      throw new Error("Could not find valeurs_annuelles.csv in INSEE archive.");
    }

    const { stdout } = await execFileAsync("unzip", ["-p", zipPath, valuesFile], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });

    const rows = parseDelimitedRows(stdout, ";");
    const years = {};

    for (const row of rows) {
      if (/^\d{4}$/.test(row[0] ?? "") && isFiniteNumber(row[1])) {
        years[row[0]] = toNumber(row[1]);
      }
    }

    return {
      years: sortYearValues(years),
      provisionalYears: {},
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchEuroPriceIndex() {
  const json = await fetchJson(urls.eurostatHicpAnnual);
  return {
    years: sortYearValues(parseEurostatSingleTimeSeries(json)),
    provisionalYears: {},
    metadata: {
      updated: json.updated ?? null,
      label: json.label ?? null,
    },
  };
}

function parseEurostatSingleTimeSeries(json) {
  const timeIndex = json?.dimension?.time?.category?.index;
  if (!timeIndex || typeof json.value !== "object") {
    throw new Error("Unexpected Eurostat JSON-stat response.");
  }

  const years = {};
  for (const [year, index] of Object.entries(timeIndex)) {
    const value = json.value[String(index)];
    if (/^\d{4}$/.test(year) && isFiniteNumber(value)) {
      years[year] = toNumber(value);
    }
  }
  return years;
}

async function fetchUsdPriceIndex() {
  const years = {};
  const monthlyByYear = {};

  for (let startYear = 1913; startYear <= currentYear; startYear += 10) {
    const endYear = Math.min(startYear + 9, currentYear);
    const payload = {
      seriesid: ["CUUR0000SA0"],
      startyear: String(startYear),
      endyear: String(endYear),
      annualaverage: true,
    };

    const json = await fetchJson(urls.blsPublicApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const series = json?.Results?.series?.[0]?.data;
    if (!Array.isArray(series)) {
      throw new Error(`Unexpected BLS response for ${startYear}-${endYear}.`);
    }

    for (const point of series) {
      const year = point.year;
      const value = toNumber(point.value);

      if (point.period === "M13") {
        years[year] = value;
      } else if (/^M\d{2}$/.test(point.period)) {
        monthlyByYear[year] ??= [];
        monthlyByYear[year].push(value);
      }
    }
  }

  const provisionalYears = {};
  for (const [year, values] of Object.entries(monthlyByYear)) {
    if (!years[year] && values.length > 0) {
      years[year] = average(values);
      provisionalYears[year] = {
        kind: "partial-year-average",
        sourceId: sourceIds.bls,
        monthCount: values.length,
        note:
          "Average of available monthly CPI-U values; not a complete annual average.",
      };
    }
  }

  return {
    years: sortYearValues(years),
    provisionalYears,
  };
}

async function fetchRussiaPriceIndex() {
  const worldBank = await fetchJson(urls.worldBankRussiaCpi);
  const [metadata, rows] = worldBank;

  if (!Array.isArray(rows)) {
    throw new Error("Unexpected World Bank Russia CPI response.");
  }

  const years = {};
  for (const row of rows) {
    if (isFiniteNumber(row.value)) {
      years[row.date] = toNumber(row.value);
    }
  }

  return {
    years: sortYearValues(years),
    provisionalYears: {},
    metadata: {
      worldBankLastUpdated: metadata?.lastupdated ?? null,
    },
  };
}

async function fetchHistoricalCurrencyConverter() {
  const html = await fetchText(urls.historicalCurrencyConverter);
  const rows = {};
  const rowPattern = /priceyear\[(\d{4})\]\s*=\s*new Array\(([^)]*)\)/g;
  let match;

  while ((match = rowPattern.exec(html)) !== null) {
    const [, year, rawValues] = match;
    rows[year] = rawValues.split(",").map(toNumber);
  }

  if (Object.keys(rows).length === 0) {
    throw new Error("Could not find priceyear data in Historical Currency Converter page.");
  }

  return {
    rows,
    metadata: {
      url: urls.historicalCurrencyConverter,
      availableRussianRubleRanges: [
        "Russian rouble [1880-1917]; actual data through 1913 in the embedded table",
        "Russian rouble [1961-1998]",
        "Russian rouble [1998-2015]",
      ],
    },
  };
}

async function fetchExchangeRates() {
  const worldBank = await fetchJson(urls.worldBankExchange);
  const [metadata, rows] = worldBank;

  if (!Array.isArray(rows)) {
    throw new Error("Unexpected World Bank exchange-rate response.");
  }

  const byCountry = {};
  for (const row of rows) {
    if (!isFiniteNumber(row.value)) {
      continue;
    }

    const country = row.countryiso3code;
    byCountry[country] ??= {};
    byCountry[country][row.date] = toNumber(row.value);
  }

  const rates = {
    GBP: {
      displayName: "British pound",
      meaning: "GBP per USD",
      sourceIds: [sourceIds.worldBankExchange],
      years: sortYearValues(byCountry.GBR ?? {}),
      provisionalYears: {},
    },
    FRF: {
      displayName: "French franc",
      meaning: "FRF per USD",
      sourceIds: [sourceIds.worldBankExchange],
      years: sortYearValues(filterYearRange(byCountry.FRA ?? {}, 1960, 1998)),
      provisionalYears: {},
      note:
        "World Bank France LCU/USD values are kept only through 1998 for French franc handling.",
    },
    EUR: {
      displayName: "Euro",
      meaning: "EUR per USD",
      sourceIds: [sourceIds.worldBankExchange],
      years: sortYearValues(filterYearRange(byCountry.EMU ?? {}, 1999, 9999)),
      provisionalYears: {},
    },
    RUR: {
      displayName: "Russian old ruble",
      meaning: "RUR per USD",
      sourceIds: [sourceIds.worldBankExchange],
      years: makePre1998RussianRubleRates(byCountry.RUS ?? {}),
      provisionalYears: {},
      note:
        "World Bank Russia exchange rates before 1998 are stored in post-redenomination scale; multiply by 1,000 for pre-1998 ruble amounts.",
    },
    RUB: {
      displayName: "Russian ruble",
      meaning: "RUB per USD",
      sourceIds: [sourceIds.worldBankExchange],
      years: sortYearValues(filterYearRange(byCountry.RUS ?? {}, 1998, 9999)),
      provisionalYears: {},
      note:
        "World Bank official exchange rates are used for modern Russian ruble handling; latest complete annual values may lag current target years.",
    },
    KRW: {
      displayName: "South Korean won",
      meaning: "KRW per USD",
      sourceIds: [sourceIds.worldBankExchange],
      years: sortYearValues(byCountry.KOR ?? {}),
      provisionalYears: {},
    },
    USD: {
      displayName: "US dollar",
      meaning: "USD per USD",
      sourceIds: [sourceIds.worldBankExchange],
      years: makeUsdIdentityYears(byCountry.USA ?? {}),
      provisionalYears: {},
    },
  };

  const ecbSupplement = await fetchEcbCurrentYearRates();
  if (ecbSupplement) {
    applyEcbSupplement(rates, ecbSupplement);
  }

  for (const entry of Object.values(rates)) {
    entry.years = sortYearValues(entry.years);
    entry.yearRange = yearRange(entry.years);
  }

  return {
    schemaVersion: 1,
    generatedAt,
    baseCurrency: "USD",
    rateMeaning: "Local currency units per 1 US dollar, annual average.",
    rates,
    metadata: {
      worldBank: {
        indicator: "PA.NUS.FCRF",
        lastUpdated: metadata?.lastupdated ?? null,
        url: urls.worldBankExchange,
      },
    },
  };
}

async function fetchEcbCurrentYearRates() {
  if (currentYear < 1999) {
    return null;
  }

  const start = `${currentYear}-01-01`;
  const end = today;
  const symbols = ["USD", "GBP", "KRW"];
  const data = {};

  for (const symbol of symbols) {
    const url = ecbExchangeUrl(symbol, start, end);
    const csv = await fetchText(url);
    data[symbol] = parseEcbExchangeCsv(csv);
  }

  const usdDates = new Set(Object.keys(data.USD));
  const commonDates = [...usdDates].filter(
    (date) => data.GBP[date] && data.KRW[date],
  );

  if (commonDates.length === 0) {
    return null;
  }

  const eurPerUsd = [];
  const gbpPerUsd = [];
  const krwPerUsd = [];

  for (const date of commonDates) {
    const usdPerEur = data.USD[date];
    eurPerUsd.push(1 / usdPerEur);
    gbpPerUsd.push(data.GBP[date] / usdPerEur);
    krwPerUsd.push(data.KRW[date] / usdPerEur);
  }

  return {
    year: String(currentYear),
    sourceId: sourceIds.ecb,
    observationCount: commonDates.length,
    firstDate: commonDates[0],
    lastDate: commonDates.at(-1),
    values: {
      EUR: average(eurPerUsd),
      GBP: average(gbpPerUsd),
      KRW: average(krwPerUsd),
      USD: 1,
    },
  };
}

function ecbExchangeUrl(symbol, start, end) {
  return `https://data-api.ecb.europa.eu/service/data/EXR/D.${symbol}.EUR.SP00.A?startPeriod=${start}&endPeriod=${end}&format=csvdata`;
}

function parseEcbExchangeCsv(csvText) {
  const rows = parseDelimitedRows(csvText, ",");
  const header = rows[0] ?? [];
  const timeIndex = header.indexOf("TIME_PERIOD");
  const valueIndex = header.indexOf("OBS_VALUE");

  if (timeIndex < 0 || valueIndex < 0) {
    throw new Error("Unexpected ECB CSV response.");
  }

  const values = {};
  for (const row of rows.slice(1)) {
    if (row[timeIndex] && isFiniteNumber(row[valueIndex])) {
      values[row[timeIndex]] = toNumber(row[valueIndex]);
    }
  }
  return values;
}

function applyEcbSupplement(rates, supplement) {
  for (const [currency, value] of Object.entries(supplement.values)) {
    if (currency === "USD") {
      continue;
    }

    if (!rates[currency]) {
      continue;
    }

    rates[currency].years[supplement.year] = value;
    if (!rates[currency].sourceIds.includes(supplement.sourceId)) {
      rates[currency].sourceIds.push(supplement.sourceId);
    }
    rates[currency].provisionalYears[supplement.year] = {
      kind: "year-to-date-average",
      sourceId: supplement.sourceId,
      observationCount: supplement.observationCount,
      firstDate: supplement.firstDate,
      lastDate: supplement.lastDate,
      note:
        "ECB daily reference rates averaged year-to-date; not a complete annual average.",
    };
  }
}

function buildPriceIndexes(gbp, frf, eur, usd, rub, historicalCurrency) {
  const frfYearRange = yearRange(frf.years);
  const rubYearRange = yearRange(rub.years);
  const historicalRubles = buildHistoricalRublePriceIndexes(historicalCurrency, usd);

  const indexes = {
    GBP: {
      displayName: "British pound",
      country: "United Kingdom",
      indexName: "UK consumer price index, long historical series",
      unit: "index",
      base: "2015 ~= 100",
      sourceIds: [sourceIds.boe, sourceIds.ons],
      years: gbp.years,
      yearRange: yearRange(gbp.years),
      provisionalYears: gbp.provisionalYears,
      metadata: gbp.metadata,
    },
    FRF: {
      displayName: "French franc",
      country: "France",
      indexName: "INSEE franc/euro purchasing-power transformation coefficient",
      unit: "index",
      base: "2025 = 100",
      sourceIds: [sourceIds.insee],
      years: frf.years,
      yearRange: frfYearRange,
      sourceYearRange: {
        start: frfYearRange.start,
        end: 1998,
      },
      provisionalYears: frf.provisionalYears,
      currencyTransition: {
        targetCurrency: "EUR",
        fixedRate: 6.55957,
        meaning: "1 EUR = 6.55957 FRF",
        effectiveYear: 1999,
      },
      note:
        "For modern target years, French-franc amounts should be moved through France purchasing power and the official FRF/EUR fixed rate.",
    },
    EUR: {
      displayName: "Euro",
      country: "Euro area",
      indexName: "Eurostat HICP annual average index",
      unit: "index",
      base: "2015 = 100",
      sourceIds: [sourceIds.eurostat],
      years: eur.years,
      yearRange: yearRange(eur.years),
      provisionalYears: eur.provisionalYears,
      usableFromYear: 1999,
      metadata: eur.metadata,
    },
    USD: {
      displayName: "US dollar",
      country: "United States",
      indexName: "BLS CPI-U, all urban consumers, all items",
      unit: "index",
      base: "1982-84 = 100",
      sourceIds: [sourceIds.bls],
      years: usd.years,
      yearRange: yearRange(usd.years),
      provisionalYears: usd.provisionalYears,
    },
    RUB_IMP: historicalRubles.RUB_IMP,
    SUR: historicalRubles.SUR,
    RUR: {
      displayName: "Russian old ruble",
      country: "Russian Federation",
      indexName: "World Bank consumer price index",
      unit: "index",
      base: "2010 = 100",
      sourceIds: [sourceIds.worldBankRussiaCpi],
      years: rub.years,
      yearRange: rubYearRange,
      sourceYearRange: {
        start: 1992,
        end: 1997,
      },
      provisionalYears: rub.provisionalYears,
      currencyTransition: {
        targetCurrency: "RUB",
        fixedRate: 1000,
        meaning: "1 RUB = 1,000 RUR",
        effectiveYear: 1998,
      },
      metadata: rub.metadata,
      note:
        "Use this entry for Russian ruble amounts before the 1998 redenomination. Amounts are adjusted through Russia CPI and moved to RUB for modern target years.",
    },
    RUB: {
      displayName: "Russian ruble",
      country: "Russian Federation",
      indexName: "World Bank consumer price index",
      unit: "index",
      base: "2010 = 100",
      sourceIds: [sourceIds.worldBankRussiaCpi],
      years: rub.years,
      yearRange: rubYearRange,
      sourceYearRange: {
        start: 1998,
        end: rubYearRange.end,
      },
      provisionalYears: rub.provisionalYears,
      metadata: rub.metadata,
      note:
        "Use this entry for Russian ruble amounts after the 1998 redenomination. Older amounts should use RUR.",
    },
  };

  return {
    schemaVersion: 1,
    generatedAt,
    description:
      "Annual price indexes for rough reading-oriented purchasing-power conversions.",
    indexes,
  };
}

function buildHistoricalRublePriceIndexes(historicalCurrency, usd) {
  const targetYears = makeHistoricalUsdBridgeTargetYears(
    historicalCurrency.rows,
    usd.years,
  );
  const targetYearRange = yearRange(targetYears);
  const provisionalYears = makeHistoricalBridgeProvisionalYears(usd.provisionalYears);
  const imperialSourceYears = makeHistoricalRubleSourceYears(
    historicalCurrency.rows,
    1880,
    1913,
    1,
  );
  const sovietSourceYears = makeHistoricalRubleSourceYears(
    historicalCurrency.rows,
    1961,
    1991,
    1000,
  );
  const imperialSourceRange = yearRange(imperialSourceYears);
  const sovietSourceRange = yearRange(sovietSourceYears);

  return {
    RUB_IMP: {
      displayName: "Russian imperial ruble",
      country: "Russian Empire",
      indexName:
        "Historicalstatistics.org Swedish consumer-goods purchasing-power bridge to USD",
      unit: "bridge index",
      base: "Target years are USD purchasing-power bridge values",
      sourceIds: [sourceIds.historicalCurrencyConverter, sourceIds.bls],
      years: sortYearValues({
        ...imperialSourceYears,
        ...targetYears,
      }),
      yearRange: yearRange({
        ...imperialSourceYears,
        ...targetYears,
      }),
      sourceYearRange: imperialSourceRange,
      targetYearRange,
      provisionalYears,
      bridgeCurrency: "USD",
      estimationKind: "historicalstatistics-swedish-consumer-bridge",
      metadata: historicalCurrency.metadata,
      note:
        "Experimental estimate. Historical rubles are bridged through Historicalstatistics.org's Swedish consumer-goods comparison and expressed as target-year USD purchasing power.",
    },
    SUR: {
      displayName: "Soviet ruble",
      country: "Soviet Union",
      indexName:
        "Historicalstatistics.org Swedish consumer-goods purchasing-power bridge to USD",
      unit: "bridge index",
      base: "Target years are USD purchasing-power bridge values",
      sourceIds: [sourceIds.historicalCurrencyConverter, sourceIds.bls],
      years: sortYearValues({
        ...sovietSourceYears,
        ...targetYears,
      }),
      yearRange: yearRange({
        ...sovietSourceYears,
        ...targetYears,
      }),
      sourceYearRange: sovietSourceRange,
      targetYearRange,
      provisionalYears,
      bridgeCurrency: "USD",
      estimationKind: "historicalstatistics-swedish-consumer-bridge",
      metadata: historicalCurrency.metadata,
      note:
        "Experimental estimate. The 1961-1998 ruble scale in Historicalstatistics.org is bridged to target-year USD purchasing power; 1992-1997 Russian rubles are handled separately as RUR.",
    },
  };
}

function makeHistoricalRubleSourceYears(rows, startYear, endYear, scale) {
  const years = {};

  for (let year = startYear; year <= endYear; year += 1) {
    const bridgeValue = getHistoricalBridgeValue(
      rows,
      year,
      HISTORICAL_RUSSIAN_RUBLE_COLUMN,
    );
    if (bridgeValue) {
      years[String(year)] = bridgeValue * scale;
    }
  }

  return sortYearValues(years);
}

function makeHistoricalUsdBridgeTargetYears(rows, usdYears) {
  const years = {};

  for (let year = 1998; year <= 2015; year += 1) {
    const bridgeValue = getHistoricalBridgeValue(
      rows,
      year,
      HISTORICAL_USD_COLUMN,
    );
    if (bridgeValue) {
      years[String(year)] = bridgeValue;
    }
  }

  const anchorYear = "2015";
  const anchorBridgeValue = years[anchorYear];
  const anchorUsdCpi = usdYears[anchorYear];
  if (!isFiniteNumber(anchorBridgeValue) || !isFiniteNumber(anchorUsdCpi)) {
    throw new Error("Could not anchor historical ruble bridge at 2015 USD.");
  }

  for (const [year, usdCpi] of Object.entries(usdYears)) {
    const numericYear = Number(year);
    if (numericYear > 2015) {
      years[year] = anchorBridgeValue * (usdCpi / anchorUsdCpi);
    }
  }

  return sortYearValues(years);
}

function makeHistoricalBridgeProvisionalYears(usdProvisionalYears) {
  const provisionalYears = {};

  for (const [year, detail] of Object.entries(usdProvisionalYears ?? {})) {
    if (Number(year) > 2015) {
      provisionalYears[year] = {
        ...detail,
        note:
          "Historical bridge extends beyond 2015 with available BLS CPI-U values; not a complete annual average when source CPI is partial.",
      };
    }
  }

  return provisionalYears;
}

function getHistoricalBridgeValue(rows, year, currencyColumn) {
  const row = rows[String(year)];
  if (!Array.isArray(row)) {
    return null;
  }

  const consumerValue = row[HISTORICAL_CONSUMER_COLUMN];
  const currencyValue = row[currencyColumn];
  if (
    !isFiniteNumber(consumerValue)
    || !isFiniteNumber(currencyValue)
    || consumerValue <= 0
    || currencyValue <= 0
  ) {
    return null;
  }

  return consumerValue * currencyValue;
}

function buildSources(exchangeRates) {
  return {
    schemaVersion: 1,
    generatedAt,
    generatedBy: "scripts/update-data.mjs",
    sources: {
      [sourceIds.boe]: {
        title: "Bank of England inflation calculator",
        publisher: "Bank of England",
        url: urls.boeInflation,
        accessedAt: generatedAt,
        use: "Long-run UK annual price index and latest monthly provisional UK values.",
      },
      [sourceIds.ons]: {
        title: "CPI INDEX 00: ALL ITEMS 2015=100 (D7BT)",
        publisher: "Office for National Statistics",
        url: urls.onsD7bt,
        accessedAt: generatedAt,
        use: "Recent UK annual CPI values where the Bank of England embedded annual data has not yet caught up.",
      },
      [sourceIds.insee]: {
        title:
          "Coefficient de transformation de l'euro ou du franc d'une annee, en euro ou en franc d'une autre annee - Base 2025",
        publisher: "INSEE",
        url: urls.inseeFrancEuro,
        accessedAt: generatedAt,
        use: "France franc/euro purchasing-power coefficient, annual 1901-2025.",
      },
      [sourceIds.bls]: {
        title: "CPI for All Urban Consumers: All Items in U.S. City Average",
        publisher: "U.S. Bureau of Labor Statistics",
        url: urls.blsPublicApi,
        seriesId: "CUUR0000SA0",
        accessedAt: generatedAt,
        use: "US CPI-U annual averages and partial current-year average when available.",
      },
      [sourceIds.eurostat]: {
        title: "HICP - annual data (average index and rate of change)",
        publisher: "Eurostat",
        url: urls.eurostatHicpAnnual,
        accessedAt: generatedAt,
        use: "Euro area annual HICP average index.",
      },
      [sourceIds.worldBankExchange]: {
        title: "Official exchange rate (LCU per US$, period average)",
        publisher: "World Bank",
        url: urls.worldBankExchange,
        accessedAt: generatedAt,
        indicator: "PA.NUS.FCRF",
        lastUpdated:
          exchangeRates?.metadata?.worldBank?.lastUpdated ?? undefined,
        use: "Annual average exchange rates through the latest complete World Bank year.",
      },
      [sourceIds.worldBankRussiaCpi]: {
        title: "Consumer price index (2010 = 100)",
        publisher: "World Bank",
        url: urls.worldBankRussiaCpi,
        accessedAt: generatedAt,
        indicator: "FP.CPI.TOTL",
        use: "Russian Federation annual CPI for 1992 onward ruble purchasing-power estimates.",
      },
      [sourceIds.historicalCurrencyConverter]: {
        title: "Historical Currency Converter (test version 1.0)",
        publisher: "Historicalstatistics.org / Rodney Edvinsson",
        url: urls.historicalCurrencyConverter,
        accessedAt: generatedAt,
        use:
          "Experimental bridge for Russian imperial and Soviet ruble estimates using Swedish consumer-goods purchasing-power comparisons.",
      },
      [sourceIds.ecb]: {
        title: "Euro foreign exchange reference rates",
        publisher: "European Central Bank",
        baseUrl: "https://data-api.ecb.europa.eu/service/data/EXR/",
        accessedAt: generatedAt,
        use: "Current-year year-to-date reference-rate supplement for EUR, GBP, and KRW against USD.",
      },
    },
    currencyTransitions: {
      FRF: {
        targetCurrency: "EUR",
        fixedRate: 6.55957,
        meaning: "1 EUR = 6.55957 FRF",
        note:
          "The French franc was fixed to the euro for conversion. Store this explicitly so calculation code does not guess.",
      },
      RUR: {
        targetCurrency: "RUB",
        fixedRate: 1000,
        meaning: "1 RUB = 1,000 RUR",
        effectiveYear: 1998,
        note:
          "The 1998 Russian redenomination changed the nominal scale. Store old ruble separately so pre-1998 amounts are not read as modern RUB.",
      },
    },
  };
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "worth-then-data-updater/1.0",
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} ${response.statusText}: ${url}`);
  }

  return response.text();
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  return JSON.parse(text);
}

async function fetchBytes(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "worth-then-data-updater/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} ${response.statusText}: ${url}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function writeJson(fileName, data) {
  await writeFile(
    join(dataDir, fileName),
    `${JSON.stringify(data, null, 2)}\n`,
    "utf8",
  );
}

function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((fields) => fields.some((value) => value.trim() !== ""));
}

function sortYearValues(values) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([year, value]) => /^\d{4}$/.test(year) && isFiniteNumber(value))
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([year, value]) => [year, roundNumber(value)]),
  );
}

function filterYearRange(values, startYear, endYear) {
  return Object.fromEntries(
    Object.entries(values).filter(([year]) => {
      const numericYear = Number(year);
      return numericYear >= startYear && numericYear <= endYear;
    }),
  );
}

function makeUsdIdentityYears(worldBankUsdYears) {
  const years = {};
  const keys = Object.keys(worldBankUsdYears);
  const start = keys.length ? Math.min(...keys.map(Number)) : 1960;

  for (let year = start; year <= currentYear; year += 1) {
    years[String(year)] = 1;
  }

  return years;
}

function makePre1998RussianRubleRates(worldBankRubYears) {
  const years = {};

  for (const [year, value] of Object.entries(worldBankRubYears)) {
    const numericYear = Number(year);
    if (numericYear >= 1992 && numericYear <= 1997) {
      years[year] = toNumber(value) * 1000;
    }
  }

  return sortYearValues(years);
}

function yearRange(years) {
  const keys = Object.keys(years).map(Number).sort((a, b) => a - b);
  return {
    start: keys[0] ?? null,
    end: keys.at(-1) ?? null,
    count: keys.length,
  };
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isFiniteNumber(value) {
  return Number.isFinite(toNumber(value));
}

function toNumber(value) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value !== "string") {
    return Number.NaN;
  }

  return Number(value.trim().replace(",", "."));
}

function roundNumber(value, digits = 6) {
  return Number(toNumber(value).toFixed(digits));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
