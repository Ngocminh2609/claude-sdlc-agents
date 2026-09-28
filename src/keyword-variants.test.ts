import { describe, expect, it } from "vitest";
import { keywordVariants, stripDiacritics } from "./keyword-variants.js";

describe("stripDiacritics", () => {
  it("removes Vietnamese tone marks and đ", () => {
    expect(stripDiacritics("Danh mục nghề nghiệp")).toBe("Danh muc nghe nghiep");
    expect(stripDiacritics("Đơn vị tính")).toBe("Don vi tinh");
  });
});

describe("keywordVariants", () => {
  it("produces the spellings code uses for a Vietnamese keyword", () => {
    const variants = keywordVariants("nghề nghiệp");

    expect(variants).toEqual(
      expect.arrayContaining([
        "nghề nghiệp",
        "nghe nghiep",
        "nghenghiep",
        "nghe_nghiep",
        "nghe-nghiep",
        "ngheNghiep",
        "NgheNghiep",
        "NGHE_NGHIEP",
      ]),
    );
  });

  it("handles an English keyword and a single word without duplicates", () => {
    expect(keywordVariants("occupation")).toEqual(["occupation", "Occupation", "OCCUPATION"]);
  });

  it("returns nothing for an empty keyword", () => {
    expect(keywordVariants("   ")).toEqual([]);
  });
});
