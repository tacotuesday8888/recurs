export function parseSingleNpmViewString(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("npm view output must contain one string value.");
  }

  const values = Array.isArray(value) ? value : [value];
  if (values.length !== 1 || typeof values[0] !== "string" || values[0].length === 0) {
    throw new Error("npm view output must contain one string value.");
  }
  return values[0];
}
