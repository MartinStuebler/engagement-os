const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 5, minInstances: 0 });

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const SKILL = fs.readFileSync(path.join(__dirname, "twin-skill.md"), "utf8");

// Free, no API. Drives the live takeaway on the cockpit.
function distill(text) {
  const t = (text || "").toLowerCase();
  if (/team|roll|others|second|everyone|colleague/.test(t)) return "Rollout question. Signals readiness to expand beyond the first user.";
  if (/bias|complian|privacy|legal|data|gdpr/.test(t)) return "Trust and risk concern surfaced. Send the compliance summary.";
  if (/worth|value|roi|skeptic|not sure|busy|time/.test(t)) return "Value being weighed. Engineer a visible win.";
  if (/report|metric|insight|dashboard/.test(t)) return "Reaching for Reports. Deeper than notetaking alone.";
  if (/start|begin|setup|onboard|first/.test(t)) return "Early ramp. Self-serving onboarding.";
  if (/notetaker|notes|record|transcri/.test(t)) return "Notetaker adoption. Core habit forming.";
  return "New engagement captured.";
}

// Build an alternating, user-first message list for the API.
function normalize(history) {
  const out = [];
  for (const m of history) {
    if (!m.content) continue;
    if (out.length && out[out.length - 1].role === m.role) {
      out[out.length - 1].content += "\n" + m.content;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

exports.onCustomerMessage = onDocumentCreated(
  { document: "conversations/{accountId}/messages/{messageId}", secrets: [ANTHROPIC_API_KEY] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const msg = snap.data();
    if (msg.role !== "customer") return; // no self-trigger, no reply to human messages

    const accountId = event.params.accountId;
    const db = admin.firestore();
    const msgsRef = db.collection("conversations").doc(accountId).collection("messages");

    // free distill on the incoming message
    try { await snap.ref.update({ takeaway: distill(msg.text) }); } catch (e) { console.error("distill", e); }

    // lightweight count for the hard cap, instead of reading the whole thread
    const total = (await msgsRef.count().get()).data().count;

    // hard cap to bound paid calls from an open link
    if (total > 20) {
      await msgsRef.add({
        role: "twin",
        text: "We've covered a lot of ground. What's the single biggest blocker for you right now? Let's nail that one.",
        takeaway: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    }

    // manual takeover: if Martin is in, do not auto-reply
    const acctSnap = await db.collection("accounts").doc(accountId).get();
    const acct = acctSnap.exists ? acctSnap.data() : { name: accountId };
    if ((acct.mode || "ai") === "human") return;

    const ctx = `\n\nYou are talking to the recruiting team at ${acct.name || accountId}. Keep it specific to them.`;
    // fetch only the last 8 messages, rather than reading the full thread and slicing in memory
    const recent = (await msgsRef.orderBy("createdAt", "asc").limitToLast(8).get()).docs.map((d) => d.data());
    const history = normalize(recent.map((m) => ({
      role: m.role === "customer" ? "user" : "assistant",
      content: m.text || ""
    })));

    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const resp = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 90,
        system: SKILL + ctx,
        messages: history
      });
      const text = (resp.content || [])
        .filter((b) => b.type === "text").map((b) => b.text).join(" ").trim()
        || "Sorry, that didn't come through. Mind saying it again?";
      await msgsRef.add({ role: "twin", text, takeaway: null, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
      console.error("twin error", err);
      await msgsRef.add({
        role: "twin",
        text: "Hmm, that glitched on my end. Mind sending that again?",
        takeaway: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }
);
