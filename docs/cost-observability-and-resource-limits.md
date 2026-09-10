# Cost observability and resource limits

Lepidy keeps cost telemetry inside each tenant's workspace object. Events are
rolled into five-minute buckets, so observation does not create a second write
for every product event. Only workspace owners and administrators may read the
report.

## What is measured

The report separates observed values from its 30-day forecast. It includes
logical requests and writes at the common mutation and scheduler boundaries,
active handler time, queue delivery attempts, member- and runner-socket time,
runner execution time, R2 operations, and the current bytes held by available
attachments. Runner idle time is measured as connected time minus execution
time. A connection still open at the end of a report window is accounted for
when it closes, so short windows can understate live socket time.

Rows read and written are logical application counters, not Cloudflare billing
statements. Forecasts use the marginal rates recorded in HLD section 13 and are
labelled low confidence under one day, medium under seven days, and high only
after seven days. They are planning estimates, never invoices.

## Published ceilings

| Resource | Workspace ceiling |
|---|---:|
| Human members | 50 |
| Concurrent workspace sockets | 500 |
| Concurrent runs per runner device | 4 |
| Agent starts per workspace per minute | 120 |
| MCP writes per connection per minute | 120 |
| Attachment storage | 10 GiB |

The socket ceiling is enforced before accepting a connection and the refused
attempt is written to the aggregated limit-event stream. The other ceilings are
owned by their existing authority paths (membership, runner scheduling, MCP
rate limiting, and attachment entitlement); this document is the shared public
contract so those paths cannot silently drift.

Operators should treat 80% utilization as a warning and 100% as critical. The
usage report includes up to 200 recent limit events for the requested window.
O02 provides the counters and alarms; G03 owns production-shaped load and cost
qualification at 50 humans and 500 sockets.
