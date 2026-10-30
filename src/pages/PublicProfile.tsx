import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { durationLabel } from "../lib/time";
import { IconChevron, IconClock } from "../components/Icons";
import { Loading } from "../App";
import { Initials } from "./BookingPage";

interface Data {
  host: { name: string; handle: string };
  paused: boolean;
  links: { slug: string; title: string; description: string | null; duration_min: number; location: string | null }[];
}

export default function PublicProfile() {
  const { handle = "" } = useParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Data>(`/public/${handle}`, { auth: false }).then((d) => {
      setData(d);
      document.title = `Book time with ${d.host.name}`;
    }).catch((e) => setError(e.message));
  }, [handle]);

  if (error) return <div className="booking-wrap"><div className="card center stack" style={{ maxWidth: 420 }}><h2>{error}</h2><Link to="/" className="small">Kairo Link</Link></div></div>;
  if (!data) return <Loading />;

  return (
    <div className="booking-wrap">
      <div className="card stack-lg" style={{ maxWidth: 560, width: "100%", alignSelf: "flex-start", padding: 32 }}>
        <div className="row">
          <Initials name={data.host.name} />
          <div>
            <h1 style={{ fontSize: 22 }}>{data.host.name}</h1>
            <p className="muted small">Pick a meeting type</p>
          </div>
        </div>
        {data.paused ? (
          <div className="alert info">Booking is paused right now. Please contact {data.host.name} directly.</div>
        ) : data.links.length === 0 ? (
          <div className="empty">No booking links available.</div>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {data.links.map((l) => (
              <Link key={l.slug} to={`/${data.host.handle}/${l.slug}`} className="card flat spread" style={{ color: "inherit", textDecoration: "none", padding: 16 }}>
                <div>
                  <p style={{ fontWeight: 600 }}>{l.title}</p>
                  <p className="meta small" style={{ marginTop: 4 }}><IconClock />{durationLabel(l.duration_min)}{l.location ? ` · ${l.location}` : ""}</p>
                </div>
                <IconChevron width={18} />
              </Link>
            ))}
          </div>
        )}
        <Link to="/" className="small faint center">Powered by Kairo Link</Link>
      </div>
    </div>
  );
}
