/**
 * The Furan test name for a Playwright test: its title path, led by the
 * project's name when it has one. Step names start with it too, so two
 * projects that share a browser and viewport (light/dark, logged-in/out,
 * branded Chrome and Edge) never share a baseline.
 */
export function testTitle(info: {
  titlePath: readonly string[];
  project: { name: string };
}): string {
  const parts = info.project.name
    ? [info.project.name, ...info.titlePath]
    : [...info.titlePath];
  return parts.join(" › ");
}
