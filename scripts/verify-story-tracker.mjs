import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const workbookPath = process.env.STORY_TRACKER_PATH || path.join(ROOT, "artifacts/story-tracker/jpyc-feature-story-status.xlsx");

const requiredSheets = [
  ["Summary", "A1:B25"],
  ["Requirements Audit", "A1:E11"],
  ["Feature Catalog", "A1:H31"],
  ["Stories", "A1:H39"],
  ["Story Test Matrix", "A1:I39"],
  ["Manual Retest Scripts", "A1:L39"],
  ["Retest Execution Audit", "A1:L39"],
  ["Actor Coverage Summary", "A1:K6"],
  ["Endpoint Coverage", "A1:J72"],
  ["Test Coverage", "A1:F171"],
  ["Validation Log", "A1:E88"],
  ["Error Log", "A1:F17"],
  ["Completion Audit", "A1:F13"],
  ["Objective Completion Audit", "A1:G13"],
  ["Goal Closure Gate", "A1:G15"],
  ["Remaining Execution Queue", "A1:L13"],
  ["External Action Plan", "A1:I12"],
  ["Evidence Index", "A1:H20"],
  ["Validation Crosswalk", "A1:I21"],
];

const requiredStrings = [
  "OBJ-010",
  "Goal Closure Gate GATE-012: No.",
  "ERR-012",
  "ERR-013",
  "ERR-014",
  "EVID-015",
  "EVID-016",
  "EVID-017",
  "story-ui-retest-20260625T000539Z",
  "story-api-retest/20260625T000546Z",
  "20260625T000548Z",
  "20260625T000549Z",
  "VC-017",
  "VC-018",
  "npm run story:retest",
  "npm run story:tracker:verify",
  "55 assertions",
  "All 36 stories have local automated plus representative browser/API/guardrail evidence; latest API retest has 55 assertions and 54 evidence rows; 14 errors/issues tracked.",
];

async function unzipText(entry) {
  const { stdout } = await execFileAsync("unzip", ["-p", workbookPath, entry], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

function decodeXml(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function parseAttributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<(?:\w+:)?si\b[\s\S]*?<\/(?:\w+:)?si>/g)].map(([si]) => {
    const parts = [...si.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((match) => decodeXml(match[1]));
    return parts.join("");
  });
}

function parseWorkbookSheets(workbookXml) {
  return [...workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((match) => parseAttributes(match[0]));
}

function parseRelationships(relsXml) {
  const relationships = new Map();
  for (const match of relsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0]);
    if (attrs.Id && attrs.Target) relationships.set(attrs.Id, attrs.Target.replace(/^\//, ""));
  }
  return relationships;
}

function normalizeWorksheetTarget(target) {
  if (target.startsWith("xl/")) return target;
  return `xl/${target.replace(/^\.\.\//, "")}`;
}

function columnToNumber(column) {
  return [...column].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
}

function numberToColumn(number) {
  let value = number;
  let column = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

function usedRangeFromCells(sheetXml) {
  let maxColumn = 0;
  let maxRow = 0;
  for (const match of sheetXml.matchAll(/\br="([A-Z]+)(\d+)"/g)) {
    maxColumn = Math.max(maxColumn, columnToNumber(match[1]));
    maxRow = Math.max(maxRow, Number(match[2]));
  }
  return maxColumn && maxRow ? `A1:${numberToColumn(maxColumn)}${maxRow}` : "";
}

function getInlineText(cellXml) {
  const inline = cellXml.match(/<(?:\w+:)?is\b[\s\S]*?<\/(?:\w+:)?is>/);
  if (!inline) return "";
  return [...inline[0].matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((match) => decodeXml(match[1])).join("");
}

function sheetText(sheetXml, sharedStrings) {
  const values = [];
  for (const match of sheetXml.matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
    const attrs = parseAttributes(match[1]);
    const body = match[2];
    if (attrs.t === "s") {
      const valueIndex = Number(body.match(/<(?:\w+:)?v>(.*?)<\/(?:\w+:)?v>/)?.[1]);
      if (Number.isInteger(valueIndex)) values.push(sharedStrings[valueIndex] || "");
    } else if (attrs.t === "inlineStr") {
      values.push(getInlineText(body));
    } else {
      const value = body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
      if (value) values.push(decodeXml(value));
    }
  }
  return values.join("\n");
}

const [workbookXml, relsXml, sharedStringsXml] = await Promise.all([
  unzipText("xl/workbook.xml"),
  unzipText("xl/_rels/workbook.xml.rels"),
  unzipText("xl/sharedStrings.xml"),
]);

const sharedStrings = parseSharedStrings(sharedStringsXml);
const sheetDefs = parseWorkbookSheets(workbookXml);
const relationships = parseRelationships(relsXml);
const sheetInfo = new Map();

for (const sheet of sheetDefs) {
  const relationshipId = sheet["r:id"];
  const target = relationshipId ? relationships.get(relationshipId) : null;
  if (!sheet.name || !target) continue;
  const sheetXml = await unzipText(normalizeWorksheetTarget(target));
  const dimension = sheetXml.match(/<(?:\w+:)?dimension ref="([^"]+)"/)?.[1] || usedRangeFromCells(sheetXml);
  sheetInfo.set(sheet.name, {
    dimension,
    text: sheetText(sheetXml, sharedStrings),
  });
}

for (const [sheetName, expectedDimension] of requiredSheets) {
  const sheet = sheetInfo.get(sheetName);
  assert.ok(sheet, `missing required sheet: ${sheetName}`);
  assert.equal(sheet.dimension, expectedDimension, `${sheetName} dimension changed`);
}

const workbookText = [...sheetInfo.values()].map((sheet) => sheet.text).join("\n");
for (const required of requiredStrings) {
  assert.ok(workbookText.includes(required), `required workbook text not found: ${required}`);
}

const result = {
  ok: true,
  workbook_path: path.relative(ROOT, workbookPath),
  sheet_count: sheetInfo.size,
  required_sheet_count: requiredSheets.length,
  checked_strings: requiredStrings.length,
};

console.log(JSON.stringify(result, null, 2));
