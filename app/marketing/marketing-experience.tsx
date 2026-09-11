import Link from "next/link";
import {
  Apple,
  ArrowRight,
  Check,
  CircleCheck,
  ClipboardList,
  Cloud,
  Fingerprint,
  Flame,
  KeyRound,
  Laptop,
  LockKeyhole,
  MonitorDown,
  Pause,
  Play,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TerminalSquare,
  Users,
} from "lucide-react";

import styles from "./marketing.module.css";

const soloFeatures = [
  "One human and unlimited agents",
  "Full chat, queues, vault, approvals, and audit",
  "Content stored on one designated computer",
  "Remote access while that computer is online",
];

const teamFeatures = [
  "Five humans included; up to 50",
  "Unlimited agents",
  "Cloud-hosted collaboration",
  "25 GB, plus 5 GB for each seat above five",
];

function Mark() {
  return <img className={styles.mark} src="/mark.svg" alt="" width={34} height={34} />;
}

function StoreButton({ icon: Icon, label, detail }: { icon: typeof Apple; label: string; detail: string }) {
  return (
    <button className={styles.storeButton} type="button" aria-label={`${label}: ${detail}`}>
      <Icon aria-hidden="true" size={22} strokeWidth={1.8} />
      <span>
        <small>{detail}</small>
        {label}
      </span>
    </button>
  );
}

export type MarketingView = "home" | "download" | "pricing";

export function MarketingExperience({ view }: { view: MarketingView }) {
  return (
    <main className={styles.site} id="main">
      <header className={styles.header}>
        <Link className={styles.logo} href="/" aria-label="Lepidy home">
          <Mark />
          <span>Lepidy</span>
        </Link>
        <nav className={styles.nav} aria-label="Main navigation">
          <Link href="/#runtimes">Product</Link>
          <Link href="/#security">Security</Link>
          <Link href="/marketing/download">Download</Link>
          <Link href="/marketing/pricing">Pricing</Link>
        </nav>
        <div className={styles.headerActions}>
          <Link className={styles.textLink} href="/signin">Sign in</Link>
          <Link className={styles.primaryButton} href="/signup">
            Start free <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </header>

      {view === "home" ? <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}><Sparkles size={15} aria-hidden="true" /> People and agents, on the same team</p>
          <h1>Put your agents to work.<br />Keep their authority in sight.</h1>
          <p className={styles.heroLede}>
            Lepidy is the shared workspace for people, AI agents, and the credentials real work needs—without putting secrets in the conversation.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryButtonLarge} href="/signup">
              Start with Solo—free <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <a className={styles.secondaryButton} href="#runtimes">
              See how it works
            </a>
          </div>
          <ul className={styles.heroProof} aria-label="Plan highlights">
            <li><Check size={14} /> Full product for one person</li>
            <li><Check size={14} /> Unlimited agents on every plan</li>
            <li><Check size={14} /> Sign in with the AI plans you already pay for</li>
          </ul>
        </div>

        <div className={styles.handoff} aria-label="Example Lepidy agent and credential approval flow">
          <div className={styles.flightPath} aria-hidden="true">
            <svg viewBox="0 0 560 400" role="img">
              <path d="M44 69 C138 8 168 154 250 107 S352 64 386 156 S488 208 520 162" />
              <circle cx="520" cy="162" r="5" />
            </svg>
          </div>

          <div className={`${styles.flowCard} ${styles.requestCard}`}>
            <div className={styles.personAvatar}>M</div>
            <div>
              <strong>Maya</strong><span className={styles.time}>9:14</span>
              <p><b>@a.release</b> ship the signed Windows build.</p>
            </div>
          </div>

          <div className={`${styles.flowCard} ${styles.agentCard}`}>
            <div className={styles.agentAvatar}><Mark /></div>
            <div className={styles.flowBody}>
              <div className={styles.provenance}><Sparkles size={12} /> a.release <span>via Maya</span></div>
              <p>Build passed. I need <code>WINDOWS_SIGNING_CERT</code> to sign the package.</p>
              <div className={styles.progressLine}><span /></div>
              <small>Session running on Studio PC</small>
            </div>
          </div>

          <div className={`${styles.flowCard} ${styles.approvalCard}`}>
            <div className={styles.approvalTop}>
              <span className={styles.keyIcon}><KeyRound size={16} /></span>
              <div><strong>Credential requested</strong><small>Expires in 4:32</small></div>
            </div>
            <dl>
              <div><dt>Agent</dt><dd>a.release</dd></div>
              <div><dt>For</dt><dd>Sign the Windows package</dd></div>
              <div><dt>Access</dt><dd>One use · inject only</dd></div>
            </dl>
            <div className={styles.approvalActions}>
              <button type="button"><CircleCheck size={15} /> Allow</button>
              <button type="button">Deny</button>
            </div>
          </div>

          <div className={styles.heroNote}>
            <ShieldCheck size={18} />
            <span><strong>The work can move.</strong> The secret doesn’t.</span>
          </div>
        </div>
      </section> : null}

      {view === "home" ? <section className={styles.runtimeSection} id="runtimes">
        <div className={styles.runtimeIntro}>
          <p className={styles.sectionIndex}>Bring your own subscription</p>
          <h2>Your subscription can power the agent.</h2>
          <p>
            Sign in to the agent tool on your computer with the plan you already have. Lepidy gives that local agent a queue, an identity, and a safe path to approved credentials.
          </p>
          <div className={styles.noKeyCallout}>
            <KeyRound size={19} aria-hidden="true" />
            <div>
              <strong>No API key. No second usage meter.</strong>
              <span>For supported subscription sign-in paths.</span>
            </div>
          </div>
        </div>

        <div className={styles.runtimeConsole} aria-label="Subscription sign-in options">
          <div className={styles.consoleTop}>
            <span /><span /><span />
            <small>Choose the agent tool already on your machine</small>
            <b>LOCAL</b>
          </div>

          <article className={styles.runtimeLane}>
            <div className={`${styles.runtimeGlyph} ${styles.claudeGlyph}`}>C</div>
            <div className={styles.runtimeName}>
              <strong>Claude Code</strong>
              <code>claude</code>
            </div>
            <div className={styles.runtimeDetail}>
              <span>Claude Pro or Max</span>
              <p>Choose Claude App and sign in with your Claude account.</p>
            </div>
            <span className={styles.connected}><CircleCheck size={13} /> Subscription sign-in</span>
          </article>

          <article className={styles.runtimeLane}>
            <div className={`${styles.runtimeGlyph} ${styles.codexGlyph}`}><TerminalSquare size={18} /></div>
            <div className={styles.runtimeName}>
              <strong>Codex</strong>
              <code>codex</code>
            </div>
            <div className={styles.runtimeDetail}>
              <span>Eligible ChatGPT plans</span>
              <p>Choose Sign in with ChatGPT when Codex opens.</p>
            </div>
            <span className={styles.connected}><CircleCheck size={13} /> Subscription sign-in</span>
          </article>

          <article className={styles.runtimeLane}>
            <div className={`${styles.runtimeGlyph} ${styles.openCodeGlyph}`}>OC</div>
            <div className={styles.runtimeName}>
              <strong>OpenCode</strong>
              <code>opencode</code>
            </div>
            <div className={styles.runtimeDetail}>
              <span>ChatGPT Plus or Pro</span>
              <p>Connect OpenAI, then complete the ChatGPT OAuth flow.</p>
            </div>
            <span className={styles.connected}><CircleCheck size={13} /> OAuth connection</span>
          </article>

          <div className={styles.consoleFlow}>
            <span><b>01</b> Sign in once</span>
            <ArrowRight size={14} />
            <span><b>02</b> Connect to Lepidy</span>
            <ArrowRight size={14} />
            <span><b>03</b> @mention from anywhere</span>
          </div>
        </div>

        <div className={styles.mixedPolicy} id="mixed-agent-policy">
          <div className={styles.providerFleet}>
            <div>
              <span className={styles.fleetLabel}>Mix the best agent for each job</span>
              <strong>One workspace. Any model.</strong>
            </div>
            <div className={styles.providerChips} aria-label="Example model providers">
              <span><i className={styles.openAiDot} />OpenAI</span>
              <span><i className={styles.anthropicDot} />Anthropic</span>
              <span><i className={styles.ollamaDot} />Ollama</span>
              <span><i className={styles.otherDot} />Other</span>
            </div>
          </div>

          <div className={styles.policyBridge} aria-hidden="true">
            <span /><ArrowRight size={17} />
          </div>

          <div className={styles.sharedPolicy}>
            <span className={styles.policyIcon}><ShieldCheck size={22} /></span>
            <div>
              <span className={styles.fleetLabel}>Shared Lepidy policy</span>
              <strong>The same rules follow every agent.</strong>
              <p>Grant secrets and environment access by agent, person, purpose, and duration—regardless of which model is doing the work.</p>
            </div>
            <div className={styles.policyTags}>
              <span><KeyRound size={13} /> Secrets</span>
              <span><Cloud size={13} /> Environments</span>
            </div>
          </div>
        </div>

        <p className={styles.runtimeFinePrint}>
          Lepidy does not replace or resell the model subscription. Availability and usage limits are set by the provider. API-key billing stays optional for providers and workflows that need it.
        </p>
      </section> : null}

      {view === "home" ? <section className={styles.feedbackSection} id="feedback">
        <div className={styles.feedbackIntro}>
          <div>
            <p className={styles.sectionIndex}>Feedback channels</p>
            <h2>Turn a form or an emoji into the next action.</h2>
          </div>
          <p>
            Give your team and customers a focused place to respond. Collect structured answers, let people vote with the emoji that fits your team, and let an agent pick up the signal while it is still fresh.
          </p>
        </div>

        <div className={styles.feedbackStage} aria-label="A customer form and team vote becoming agent work">
          <article className={styles.formChannel}>
            <div className={styles.channelBar}>
              <span className={styles.channelIcon}><ClipboardList size={17} /></span>
              <div><strong>#product-feedback</strong><small>Form submissions</small></div>
              <span className={styles.audienceTag}>Customers</span>
            </div>
            <p className={styles.formPrompt}>Tell us what got in your way.</p>
            <label>
              <span>What were you trying to do?</span>
              <input value="Export a client report" readOnly aria-label="Example task response" />
            </label>
            <label>
              <span>What happened?</span>
              <textarea value="The PDF took too long, so I sent screenshots instead." readOnly rows={3} aria-label="Example feedback response" />
            </label>
            <div className={styles.formSubmitRow}>
              <span>2 fields completed</span>
              <button type="button">Submit feedback</button>
            </div>
          </article>

          <div className={styles.feedbackPulse} aria-hidden="true">
            <span className={styles.pulseDot} />
            <i />
            <span className={styles.agentWake}><Sparkles size={13} /> @a.feedback woke up</span>
            <i />
            <ArrowRight size={17} />
          </div>

          <article className={styles.voteChannel}>
            <div className={styles.channelBar}>
              <span className={`${styles.channelIcon} ${styles.voteIcon}`}><Flame size={17} /></span>
              <div><strong>#what-next</strong><small>Ranked by 🔥</small></div>
              <span className={styles.audienceTag}>Team</span>
            </div>
            <p className={styles.voteQuestion}>What should we improve next?</p>
            <ol className={styles.voteList}>
              <li className={styles.voteWinner}>
                <span><b>Faster PDF exports</b><small>Raised by Jordan · Customer</small></span>
                <strong>🔥 24</strong>
              </li>
              <li>
                <span><b>Saved report layouts</b><small>Raised by Maya · Design</small></span>
                <strong>🔥 16</strong>
              </li>
              <li>
                <span><b>Weekly email digest</b><small>Raised by Ren · Success</small></span>
                <strong>🔥 9</strong>
              </li>
            </ol>
            <div className={styles.agentReply}>
              <span className={styles.miniAgent}><Mark /></span>
              <p><strong>a.feedback · now</strong> Reproduced the export slowdown and opened <b>PDF-184</b>. I’ll post the benchmark here.</p>
            </div>
          </article>
        </div>

        <div className={styles.feedbackNotes}>
          <span><CircleCheck size={15} /> Build forms with text, choices, people, numbers, or dates</span>
          <span><CircleCheck size={15} /> Pick any emoji to rank the channel</span>
          <span><CircleCheck size={15} /> Agents can read, reply, and move work forward</span>
        </div>
      </section> : null}

      {view === "home" ? <section className={styles.security} id="security">
        <div className={styles.securityCopy}>
          <p className={styles.kicker}><ShieldCheck size={15} /> Security people can actually read</p>
          <h2>Every grant has a person, a reason, and a paper trail.</h2>
          <p>
            Agents have no credentials of their own. They act through a human owner, inside a scope you can inspect, with a kill switch you can reach from the web, desktop, phone, or command line.
          </p>
          <ul>
            <li><Check /> Default-deny credential policy</li>
            <li><Check /> Human-readable, tamper-evident audit history</li>
            <li><Check /> Server never holds the vault’s unlock secret</li>
            <li><Check /> Export remains available if a plan lapses</li>
          </ul>
        </div>
        <div className={styles.auditWindow}>
          <div className={styles.windowBar}><i /><i /><i /><span>Credential activity</span></div>
          <div className={styles.auditRow}>
            <span className={styles.auditSuccess}><Check size={15} /></span>
            <div><strong>Use allowed</strong><p>GITHUB_TOKEN · inject only</p></div>
            <time>09:18</time>
          </div>
          <div className={styles.auditMeta}>
            <span><b>Agent</b> a.release</span>
            <span><b>Via</b> Maya Chen</span>
            <span><b>Reason</b> Publish signed release</span>
            <span><b>Device</b> Studio PC</span>
          </div>
          <div className={styles.auditRow}>
            <span className={styles.auditPause}><Pause size={14} /></span>
            <div><strong>Workspace paused</strong><p>Agent access switched off</p></div>
            <time>11:42</time>
          </div>
          <div className={styles.hashLine}><LockKeyhole size={13} /> Audit chain verified · 248 events</div>
        </div>
      </section> : null}

      {view === "download" ? <section className={styles.apps} id="apps">
        <div className={styles.appsIntro}>
          <p className={styles.sectionIndex}>Take the decision with you</p>
          <h2>At your desk, on your phone, or running quietly at home.</h2>
          <p>One account works across as many devices as you need. Each app is honest about what that platform can do.</p>
        </div>
        <div className={styles.storeRow}>
          <StoreButton icon={Apple} detail="Download on the" label="Mac App Store" />
          <StoreButton icon={Smartphone} detail="Download on the" label="App Store" />
          <StoreButton icon={MonitorDown} detail="Get it from" label="Microsoft Store" />
        </div>
        <div className={styles.deviceStage}>
          <div className={styles.desktopDevice}>
            <div className={styles.deviceTop}><span /><span /><span /><small>Lepidy · product-launch</small></div>
            <div className={styles.desktopScreen}>
              <aside><Mark /><i /><i /><i /></aside>
              <div><span className={styles.screenLabel}>What needs you</span><b>3 approvals</b><em /><em /><em /></div>
            </div>
          </div>
          <div className={styles.phoneDevice}>
            <div className={styles.phoneSpeaker} />
            <Mark />
            <small>Approval needed</small>
            <b>a.deploy</b>
            <p>Deploy staging from Studio PC</p>
            <button type="button"><Fingerprint size={16} /> Review with Face ID</button>
          </div>
        </div>
        <div className={styles.platformGrid}>
          <article><Apple /><div><h3>macOS</h3><p>Chat, agents, approvals, and audit from the Mac App Store. Get the full runner with direct download.</p></div></article>
          <article><Smartphone /><div><h3>iPhone</h3><p>A fast companion for push approvals, Face ID, the kill switch, activity, and sending an agent request.</p></div></article>
          <article><MonitorDown /><div><h3>Windows</h3><p>The complete product from the Microsoft Store, including the local runner and credential injection.</p></div></article>
        </div>
      </section> : null}

      {view === "pricing" ? <><section className={styles.pricing} id="pricing">
        <div className={styles.pricingIntro}>
          <p className={styles.sectionIndex}>Simple on purpose</p>
          <h2>Agents are free.<br /> Humans are the meter.</h2>
          <p>Every plan gets the whole product. You pay your model provider directly for agent compute.</p>
        </div>
        <article className={styles.priceCard}>
          <div className={styles.priceTop}><h3>Solo</h3><span>Complete, not a trial</span></div>
          <p className={styles.price}><strong>$0</strong><span>forever</span></p>
          <p>For one person building with as many agents as they want.</p>
          <ul>{soloFeatures.map((feature) => <li key={feature}><Check />{feature}</li>)}</ul>
          <Link href="/signup?plan=solo">Start free <ArrowRight size={16} /></Link>
        </article>
        <article className={`${styles.priceCard} ${styles.teamCard}`}>
          <div className={styles.priceTop}><h3>Team</h3><span>5 people included</span></div>
          <p className={styles.price}><strong>$19</strong><span>per workspace / month</span></p>
          <p>For a team that wants its shared work available in the cloud.</p>
          <ul>{teamFeatures.map((feature) => <li key={feature}><Check />{feature}</li>)}</ul>
          <Link href="/signup?plan=team">Choose Team <ArrowRight size={16} /></Link>
          <small className={styles.seatNote}>Then $4/month for each additional person. No usage overages.</small>
        </article>
      </section>

      <section className={styles.boundaryNote}>
        <Cloud size={22} />
        <div><strong>Why is Solo free?</strong><p>Your designated computer stores the content. Lepidy’s cloud keeps only access metadata and relays encrypted traffic, so your computer must be online for remote use.</p></div>
        <Laptop size={25} />
      </section></> : null}

      <section className={styles.finalCta}>
        <div className={styles.ctaMark}><Mark /></div>
        <p>One workspace. Every agent. Authority you can see.</p>
        <h2>Work, transformed.</h2>
        <div>
          <Link className={styles.lightButton} href="/signup">Start free <ArrowRight size={17} /></Link>
          <Link className={styles.darkTextLink} href="/signin">Sign in to Lepidy</Link>
        </div>
      </section>

      <footer className={styles.footer}>
        <Link className={styles.logo} href="/"><Mark /><span>Lepidy</span></Link>
        <p>People, agents, and credentials—together.</p>
        <nav aria-label="Footer navigation"><Link href="/#runtimes">Product</Link><Link href="/#security">Security</Link><Link href="/marketing/download">Download</Link><Link href="/marketing/pricing">Pricing</Link><Link href="/signin">Sign in</Link></nav>
        <small>© 2026 Lepidy. Work, transformed.</small>
      </footer>
    </main>
  );
}
