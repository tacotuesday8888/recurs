function failure() {
  throw new Error("npm pack must return one package report.");
}

export function parseSingleNpmPackReport(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    return failure();
  }

  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== "object" ||
        value[0] === null) {
      return failure();
    }
    return value[0];
  }

  if (typeof value !== "object" || value === null) return failure();
  const entries = Object.entries(value);
  if (entries.length !== 1) return failure();
  const [name, report] = entries[0];
  if (
    typeof report !== "object" ||
    report === null ||
    report.name !== name
  ) {
    return failure();
  }
  return report;
}
