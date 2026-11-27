import { describe, expect, it } from "vitest";
import {
  extractOtherText,
  formatOtherEntry,
  isOtherEntry,
  isOtherOption,
  updateOtherInList,
} from "./fieldLogic";

describe("other/custom option helpers", () => {
  it("recognizes French and English Other/Autre option labels", () => {
    expect(isOtherOption("Autre")).toBe(true);
    expect(isOtherOption("Autre…")).toBe(true);
    expect(isOtherOption("Autre (préciser)")).toBe(true);
    expect(isOtherOption("Other")).toBe(true);
    expect(isOtherOption("Something else")).toBe(true);
    expect(isOtherOption("Personnalisé")).toBe(true);
    expect(isOtherOption("Custom...")).toBe(true);

    expect(isOtherOption("PostgreSQL")).toBe(false);
    expect(isOtherOption("Authentication")).toBe(false);
  });

  it("formats, detects, extracts, and updates Other entries in checklists", () => {
    expect(formatOtherEntry("Autre", "")).toBe("Autre");
    expect(formatOtherEntry("Autre", "  Stripe webhooks  ")).toBe("Autre: Stripe webhooks");

    expect(isOtherEntry("Autre", "Autre")).toBe(true);
    expect(isOtherEntry("Autre: Stripe", "Autre")).toBe(true);
    expect(isOtherEntry("Auth", "Autre")).toBe(false);

    expect(extractOtherText("Autre: Stripe", "Autre")).toBe("Stripe");
    expect(extractOtherText("Autre", "Autre")).toBe("");

    expect(updateOtherInList(["Auth", "Autre"], "Autre", "Stripe")).toEqual(["Auth", "Autre: Stripe"]);
    expect(updateOtherInList(["Auth", "Autre: Stripe"], "Autre", "PayPal")).toEqual(["Auth", "Autre: PayPal"]);
    expect(updateOtherInList(["Auth", "Autre: Stripe"], "Autre", "")).toEqual(["Auth", "Autre"]);
  });
});
