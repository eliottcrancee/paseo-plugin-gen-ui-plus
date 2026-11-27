import { describe, expect, it } from "vitest";
import { buildMathHtml, latexToMathMl, latexToUnicode } from "./mathMl";

describe("LaTeX to MathML & Unicode", () => {
  it("converts fractions, roots, scripts, Greek, and matrices to valid MathML", () => {
    const ml = latexToMathMl("\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}");
    expect(ml).toContain("<math ");
    expect(ml).toContain("<mfrac>");
    expect(ml).toContain("<msqrt>");
    expect(ml).toContain("<msup>");
    expect(ml).toContain("±");

    const sum = latexToMathMl("\\sum_{i=1}^{n} x_i", true);
    expect(sum).toContain("<munderover>");
    expect(sum).toContain("∑");

    const matrix = latexToMathMl("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}");
    expect(matrix).toContain("<mtable>");
    expect(matrix).toContain("<mtr>");
    expect(matrix).toContain("<mtd>");
  });

  it("escapes XML special characters safely in buildMathHtml", () => {
    const html = buildMathHtml("x < y & z > 0");
    expect(html).toContain("&lt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&gt;");
    expect(html).not.toContain("<script>");
  });

  it("produces clean Unicode math for inline/mobile fallback", () => {
    expect(latexToUnicode("\\alpha^2 + \\beta^2 = \\gamma^2")).toBe("α² + β² = γ²");
    expect(latexToUnicode("\\frac{a}{b} + \\sqrt{x}")).toBe("(a)/(b) + √(x)");
    expect(latexToUnicode("x \\in \\mathbb{R}")).toBe("x ∈ ℝ");
  });
});
