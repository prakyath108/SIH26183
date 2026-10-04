import { Link, useLocation } from "react-router-dom";
import { PageHeader, Notice } from "../components/ui";

export default function NotFound(): JSX.Element {
  const location = useLocation();

  return (
    <>
      <PageHeader title="Page not found" />
      <Notice tone="warn" title="No such module">
        <p>
          <code>{location.pathname}</code> does not match any route in this application. If you followed a link from
          inside CryptoTrace, that is a bug worth reporting.
        </p>
      </Notice>
      <div className="row-gap">
        <Link className="btn primary" to="/">
          Go to the dashboard
        </Link>
        <Link className="btn ghost" to="/investigations">
          Open investigations
        </Link>
      </div>
    </>
  );
}
