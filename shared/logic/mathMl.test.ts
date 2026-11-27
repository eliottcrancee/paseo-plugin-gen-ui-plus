import { describe, expect, it } from "vitest";
import { containsLatexMath, GENUI_TEXT_KIND, splitTimelineMessage } from "../segment";
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

  it("detects raw LaTeX in plain prose without false positives on prices or code", () => {
    expect(containsLatexMath("Voici : $$a^2 + b^2 = c^2$$")).toBe(true);
    expect(containsLatexMath("Formule : $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$")).toBe(true);
    expect(containsLatexMath("Costs $10 for basic and $25 for pro.")).toBe(false);
    expect(containsLatexMath("Use `$HOME` or ```sh\necho $$a^2$$\n```")).toBe(false);

    const split = splitTimelineMessage("Pythagore : $$a^2 + b^2 = c^2$$", "complete");
    expect(split?.items).toHaveLength(1);
    expect(split?.items[0]?.kind).toBe(GENUI_TEXT_KIND);

    expect(splitTimelineMessage("Price is $10 and $20.", "complete")).toBeUndefined();
  });
});
