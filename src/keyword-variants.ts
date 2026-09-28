/**
 * Spellings a feature keyword can take in code, so clone mode finds a feature
 * from a loose keyword ("nghề nghiệp") instead of needing its exact name.
 *
 * Vietnamese is the hard part: code rarely carries diacritics, so "nghề
 * nghiệp" shows up as `nghe_nghiep`, `ngheNghiep`, `NgheNghiep` or
 * `DM_NGHE_NGHIEP`. Those spellings are mechanical, so they are produced here
 * rather than left to the model; translating to English ("occupation") is not
 * mechanical, and the locate prompt asks the model for that part.
 */
export function stripDiacritics(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export function keywordVariants(keyword: string): string[] {
  const original = keyword.trim();
  const words = stripDiacritics(original)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return original ? [original] : [];

  const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);
  return [
    ...new Set([
      original,
      words.join(" "),
      words.join(""),
      words.join("_"),
      words.join("-"),
      words[0] + words.slice(1).map(capitalize).join(""),
      words.map(capitalize).join(""),
      words.join("_").toUpperCase(),
    ]),
  ];
}
