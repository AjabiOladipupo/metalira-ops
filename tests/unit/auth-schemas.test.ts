import { describe, expect, it } from "vitest";

import {
  formFields,
  magicLinkSchema,
  signInPasswordSchema,
  signUpSchema,
  switchOrganisationSchema,
} from "@/server/identity/schemas";

const validSignUp = {
  fullName: "  Ada Okafor ",
  companyName: " Alpha Guards Ltd ",
  email: " Ada@Example.COM ",
  password: "correcthorse9",
};

function firstMessage(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? undefined : result.error?.issues[0]?.message;
}

describe("signUpSchema", () => {
  it("trims names and lower-cases the email", () => {
    const parsed = signUpSchema.parse(validSignUp);
    expect(parsed).toEqual({
      fullName: "Ada Okafor",
      companyName: "Alpha Guards Ltd",
      email: "ada@example.com",
      password: "correcthorse9",
    });
  });

  it.each([
    ["a bad email", { email: "not-an-email" }, "Enter a valid email address"],
    ["an empty email", { email: "  " }, "Enter your email address"],
    ["a short password", { password: "abc1234" }, "Use at least 8 characters"],
    ["a long password", { password: `${"a".repeat(72)}1` }, "Use 72 characters or fewer"],
    ["a password with no number", { password: "onlyletters" }, "Use at least one number"],
    ["a password with no letter", { password: "1234567890" }, "Use at least one letter"],
    ["an empty name", { fullName: "  " }, "Enter your full name"],
    ["an empty company", { companyName: "" }, "Enter your company name"],
    ["a one-letter company", { companyName: "A" }, "Enter your company name"],
    [
      "a company over 160",
      { companyName: "A".repeat(161) },
      "Company name must be 160 characters or fewer",
    ],
    [
      "angle brackets",
      { companyName: "<b>Alpha</b>" },
      "Company name must be plain text, without < or >",
    ],
    [
      "a web address",
      { fullName: "Visit www.evil.example" },
      "Full name can't contain a web address",
    ],
    ["a link", { companyName: "https://evil.example" }, "Company name can't contain a web address"],
    [
      "a control character",
      { fullName: "Ada\u0007Okafor" },
      "Full name must be plain text, without < or >",
    ],
  ])("rejects %s", (_label, patch, message) => {
    expect(firstMessage(signUpSchema.safeParse({ ...validSignUp, ...patch }))).toBe(message);
  });
});

describe("signInPasswordSchema", () => {
  it("accepts any non-empty password, since rules may have changed since it was set", () => {
    expect(signInPasswordSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
  });

  it("requires both fields", () => {
    expect(firstMessage(signInPasswordSchema.safeParse({ email: "a@b.co", password: "" }))).toBe(
      "Enter your password",
    );
    expect(firstMessage(signInPasswordSchema.safeParse({ email: "", password: "x" }))).toBe(
      "Enter your email address",
    );
  });
});

describe("magicLinkSchema and switchOrganisationSchema", () => {
  it("validate their single fields", () => {
    expect(magicLinkSchema.safeParse({ email: "ops@alpha.example" }).success).toBe(true);
    expect(magicLinkSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(
      switchOrganisationSchema.safeParse({ organisationId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" })
        .success,
    ).toBe(true);
    expect(switchOrganisationSchema.safeParse({ organisationId: "1; drop table" }).success).toBe(
      false,
    );
  });
});

describe("formFields", () => {
  it("keeps string fields and drops files", () => {
    const form = new FormData();
    form.set("email", "a@b.co");
    form.set("upload", new Blob(["x"]), "x.txt");
    expect(formFields(form)).toEqual({ email: "a@b.co" });
  });
});
