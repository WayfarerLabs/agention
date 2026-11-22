import { PageHeading, usePageTitle } from "../components.tsx";
import { Link } from "../router.tsx";

// NotFound is the page for an address the UI has no page at.
export function NotFound() {
  usePageTitle("Not found");
  return (
    <>
      <PageHeading>Not found</PageHeading>
      <p>
        Agention has no page here. <Link to="/">Go to your threads.</Link>
      </p>
    </>
  );
}
