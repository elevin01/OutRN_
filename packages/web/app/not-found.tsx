import Link from "next/link";

export default function NotFound() {
  return <section className="not-found"><p className="eyebrow">404</p><h1>That place wandered off.</h1><p>It may have been merged, removed, or never existed in this data set.</p><Link className="primary-button" href="/">Find somewhere else</Link></section>;
}
