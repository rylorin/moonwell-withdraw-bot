import { ethers } from "ethers";
import { USDC_DECIMALS } from "./config";

function fmt(raw: bigint): string {
  return ethers.formatUnits(raw, USDC_DECIMALS);
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length > 0) parts[parts.length - 1] = "***";
    u.pathname = "/" + parts.join("/");
    return u.toString();
  } catch {
    return "(URL invalide)";
  }
}

export { fmt, maskUrl };
