// The Hire dialog's count line: how many hires work, with no cap.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HireCount } from "./hire.tsx";

test("the Hire dialog says how many hires work and names no cap", () => {
  const markup = renderToStaticMarkup(<HireCount working={3} />);
  expect(markup).toContain(">3 hires working.<");
  expect(markup).not.toContain("of 8");
  expect(markup).not.toContain("cap");
  expect(renderToStaticMarkup(<HireCount working={9} />)).toContain(">9 hires working.<");
  expect(renderToStaticMarkup(<HireCount working={null} />)).toContain("The working hires couldn&#x27;t be counted.");
});
