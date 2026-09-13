import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Absent audited data renders nothing. Invalid/present data fails the build. */
export async function buildProductComparison({ dataPath, outputPath, parse, render }) {
  let source;
  try { source = await readFile(dataPath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  const data = parse(JSON.parse(source));
  for (const href of [data.auditHref, data.protocolHref]) {
    if (href.startsWith("https://")) continue;
    const target = path.resolve(outputPath, href);
    if (!target.startsWith(path.resolve(outputPath) + path.sep) || !(await stat(target)).isFile()) throw new Error("Comparison artifact link is missing");
  }
  return render(data);
}
