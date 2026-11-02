import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import CodeBlock from "@theme/CodeBlock";
import type { ReactNode } from "react";

type Artifact =
  "furan-selenium" | "furan-playwright" | "furan-appium" | "furan-junit5";

/**
 * The SDK dependency line at the released version. The version comes from
 * packages/sdk-kotlin/version.txt (docusaurus.config.ts `customFields`), so a
 * snippet never names a version that isn't on Maven Central.
 */
export default function SdkDependency({
  artifact,
  format = "gradle",
}: {
  artifact: Artifact;
  format?: "gradle" | "maven";
}): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const version = siteConfig.customFields?.sdkVersion as string;
  if (format === "maven") {
    return (
      <CodeBlock language="xml" title="pom.xml">
        {`<dependency>
    <groupId>io.github.qasecret</groupId>
    <artifactId>${artifact}</artifactId>
    <version>${version}</version>
    <scope>test</scope>
</dependency>`}
      </CodeBlock>
    );
  }
  return (
    <CodeBlock language="kotlin" title="build.gradle.kts">
      {`testImplementation("io.github.qasecret:${artifact}:${version}")`}
    </CodeBlock>
  );
}
