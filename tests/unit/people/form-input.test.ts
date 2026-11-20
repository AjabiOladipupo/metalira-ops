import { describe, expect, it } from "vitest";

import { echoableValues, workerFormErrors, workerFormInput } from "@/server/people/form-input";
import { createWorkerSchema, updateWorkerSchema } from "@/server/people/schemas";

const W = "b0000000-0000-4000-8000-000000000002";
const M = "c0000000-0000-4000-8000-000000000003";

const form = {
  staffId: "",
  firstName: "Musa",
  lastName: "Ibrahim",
  phone: "0803 000 0002",
  employmentType: "permanent",
  startDate: "2026-11-16",
  lineManager: `w:${W}`,
  bankCode: "058",
  bankLookupId: "d0000000-0000-4000-8000-0000000000aa",
  bankAccountNumber: "0123457712",
  nin: "12345678901",
  rsaPin: "PEN100012344421",
  nhfOptIn: "on",
};

describe("workerFormInput", () => {
  it("splits the line-manager choice and makes checkboxes explicit", () => {
    const input = workerFormInput(form, "create");
    expect(input.lineManager).toBeUndefined();
    expect(input.lineManagerWorkerId).toBe(W);
    expect(input.lineManagerMembershipId).toBeNull();
    expect(input.nhfOptIn).toBe("true");
    expect(input.supervisorClockIn).toBe("false");
    expect(createWorkerSchema.safeParse(input).success).toBe(true);
  });

  it("clears both line-manager columns when none is chosen, and picking one clears the other", () => {
    expect(workerFormInput({ ...form, lineManager: "" }, "update")).toMatchObject({
      lineManagerWorkerId: null,
      lineManagerMembershipId: null,
    });
    expect(workerFormInput({ ...form, lineManager: `m:${M}` }, "update")).toMatchObject({
      lineManagerWorkerId: null,
      lineManagerMembershipId: M,
    });
  });

  it("never sends the staff ID or bank details in an update", () => {
    const input = workerFormInput({ ...form, workerId: W, staffId: "EMP-9" }, "update");
    for (const key of [
      "staffId",
      "bankCode",
      "bankLookupId",
      "nameCheckReason",
      "bankAccountNumber",
    ]) {
      expect(input).not.toHaveProperty(key);
    }
    expect(updateWorkerSchema.safeParse(input).success).toBe(true);
  });

  it("keeps personal data on file when its update input is left blank", () => {
    const input = workerFormInput({ ...form, workerId: W, nin: "", rsaPin: "" }, "update");
    const parsed = updateWorkerSchema.parse(input);
    expect(parsed.nin).toBeUndefined();
    expect(parsed.rsaPin).toBeUndefined();
  });
});

describe("workerFormErrors", () => {
  it("puts line-manager errors on the one select", () => {
    expect(
      workerFormErrors({ lineManagerMembershipId: "That line manager wasn't found.", phone: "x" }),
    ).toEqual({ lineManager: "That line manager wasn't found.", phone: "x" });
  });
});

describe("echoableValues", () => {
  it("never sends NIN, bank account number or RSA PIN back to the browser", () => {
    const echoed = echoableValues({ ...form, $ACTION_ID_abc: "", "$ACTION_1:0": "{}" });
    expect(echoed).not.toHaveProperty("nin");
    expect(echoed).not.toHaveProperty("bankAccountNumber");
    expect(echoed).not.toHaveProperty("rsaPin");
    expect(Object.keys(echoed).some((k) => k.startsWith("$ACTION"))).toBe(false);
    expect(echoed).toMatchObject({ firstName: "Musa", bankCode: "058", lineManager: `w:${W}` });
    expect(JSON.stringify(echoed)).not.toContain("12345678901");
    expect(JSON.stringify(echoed)).not.toContain("0123457712");
  });
});
