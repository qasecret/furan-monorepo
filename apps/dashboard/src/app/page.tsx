import { redirect } from "next/navigation";

/**
 * Root index: bounce to /inbox. The (protected) layout's requireJwt()
 * cascades to /login on missing cookie, so a single redirect handles both
 * the authed and unauthed cases. Without this, the bare app URL 404s —
 * Next.js route groups ((public) / (protected)) don't match the bare /
 * themselves, only the children inside.
 */
export default function RootIndex(): never {
  redirect("/inbox");
}
