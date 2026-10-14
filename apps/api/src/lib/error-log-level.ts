/**
 * The level an error the API answers with HTTP `status` is logged at. A 4xx
 * is the client's: a review refusal (409 / 412), a missing or forbidden row, a
 * validation failure. That is expected traffic, so it logs at `warn` and never
 * pages anyone. A 5xx is the server's and logs at `error`.
 */
export function errorLogLevel(status: number): "warn" | "error" {
  return status >= 400 && status < 500 ? "warn" : "error";
}
