import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableEmpty,
} from "@/components/ui/table";

afterEach(cleanup);

describe("Table", () => {
  test("renders header, body rows, and cells", () => {
    render(
      <Table>
        <TableHeader>
          <tr>
            <TableHead>Name</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          <TableRow data-testid="row-1">
            <TableCell>Alice</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByText("Name")).toBeDefined();
    expect(screen.getByText("Alice")).toBeDefined();
    expect(screen.getByTestId("row-1")).toBeTruthy();
  });

  test("TableEmpty spans the given column count", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableEmpty colSpan={3}>No data</TableEmpty>
        </TableBody>
      </Table>,
    );
    expect(container.querySelector("td")?.getAttribute("colspan")).toBe("3");
    expect(screen.getByText("No data")).toBeDefined();
  });

  test("passes className through on the table and cells", () => {
    const { container } = render(
      <Table className="custom-t">
        <TableBody>
          <TableRow>
            <TableCell className="custom-c">x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(container.querySelector("table")?.className).toContain("custom-t");
    expect(container.querySelector("td")?.className).toContain("custom-c");
  });
});
