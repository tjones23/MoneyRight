import { parseJson, ProviderError, type Transport } from "./http";
import { dollarsToCents } from "@/lib/money";

/**
 * RentCast (https://developers.rentcast.io): a home's estimated value from
 * its address — an automated valuation from nearby sales and listings, the
 * same kind of number as a Zestimate. Zillow's own Zestimate has no API
 * anyone outside its partner program can use; RentCast's free Developer
 * plan allows 50 requests a month.
 *
 * RentCast bills each request past 50 and offers no hard cap, so the cap is
 * kept here (see `RENTCAST_MONTHLY_CAP` in home-estimates.ts). Errors aren't
 * billed. The address goes to RentCast; nothing else about the person does.
 */

export interface RentcastConfig {
  apiKey: string;
}

export function rentcastConfig(): RentcastConfig | null {
  const apiKey = process.env.RENTCAST_API_KEY?.trim();
  return apiKey ? { apiKey } : null;
}

export interface HomeEstimate {
  valueCents: number;
  lowCents: number | null;
  highCents: number | null;
  /** RentCast's tidy form of the address it matched. */
  formattedAddress: string | null;
  zip: string | null;
}

export class RentcastClient {
  constructor(
    private readonly config: RentcastConfig,
    private readonly transport: Transport,
  ) {}

  async valueEstimate(address: string): Promise<HomeEstimate> {
    const url = new URL("https://api.rentcast.io/v1/avm/value");
    url.searchParams.set("address", address);
    const res = await this.transport({ method: "GET", url: url.toString(), headers: { "X-Api-Key": this.config.apiKey } });
    const json = parseJson(res.body) as {
      price?: number;
      priceRangeLow?: number;
      priceRangeHigh?: number;
      subjectProperty?: { formattedAddress?: string; zipCode?: string } | null;
      error?: string;
    } | null;
    if (res.status !== 200 || !json) {
      const code = json?.error ?? `http_${res.status}`;
      throw new ProviderError("rentcast", res.status, code, false, res.status === 429 || res.status >= 500 || res.status === 0);
    }
    const value = dollarsToCents(json.price);
    if (value === null || value <= 0) throw new ProviderError("rentcast", res.status, "no_estimate", false, false);
    const zip = json.subjectProperty?.zipCode?.slice(0, 5) ?? null;
    return {
      valueCents: value,
      lowCents: dollarsToCents(json.priceRangeLow),
      highCents: dollarsToCents(json.priceRangeHigh),
      formattedAddress: json.subjectProperty?.formattedAddress ?? null,
      zip: zip && /^\d{5}$/.test(zip) ? zip : null,
    };
  }
}
