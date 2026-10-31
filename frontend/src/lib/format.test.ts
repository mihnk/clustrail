import { describe, expect, it } from "vitest";
import { formatAge, formatCpu, formatMemory, shortContext, shortName } from "./format";

describe("formatters", () => {
  it("formats CPU in millicores and cores", () => {
    expect(formatCpu(null)).toBe("—");
    expect(formatCpu(250)).toBe("250m");
    expect(formatCpu(1500)).toBe("1.5");
    expect(formatCpu(12000)).toBe("12");
  });

  it("formats memory in Mi and Gi", () => {
    expect(formatMemory(null)).toBe("—");
    expect(formatMemory(512)).toBe("512Mi");
    expect(formatMemory(1536)).toBe("1.5Gi");
  });

  it("formats age like kubectl, rounding down", () => {
    expect([59, 60, 3599, 3600, 86399, 86400, 365 * 86400].map(formatAge)).toEqual(["59s", "1m", "59m", "1h", "23h", "1d", "1y"]);
  });

  it("shortens AWS account ids and long names", () => {
    expect(shortContext("arn:aws:eks:eu-west-1:482100000000:cluster/x")).toBe("arn:aws:eks:eu-west-1:4821…:cluster/x");
    expect(shortContext("kind-local")).toBe("kind-local");
    expect(shortName("checkout-api-7d9f8b6c4-x2kqp")).toBe("…-7d9f8b6c4-x2kqp");
    expect(shortName("short")).toBe("short");
  });
});
