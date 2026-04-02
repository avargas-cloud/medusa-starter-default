/**
 * quickbooks-nightly-verify.ts
 *
 * Nightly QuickBooks Verification Job — runs once daily at midnight (America/New_York).
 *
 * What it does:
 *   1. Queries qb_sync_log for all order-level operations from the past 24h
 *      that have a qb_operation_id (SO, Invoice, Cancel, Payment, Estimate).
 *   2. For each, polls the Bridge GET /api/sync/status/{operationId} to confirm
 *      whether the operation truly completed in QB Desktop.
 *   3. Updates any entries whose real status differs from "completed" (e.g. actually failed).
 *   4. Sends an HTML email digest via SendGrid with a full summary.
 *
 * Schedule: every 30 minutes — hour check done internally (same pattern as daily sync).
 * Report recipient: QB_REPORT_EMAIL env var (default: a.vargas@ecopowertech.com).
 */

import { MedusaContainer } from "@medusajs/framework/types"
import { Client } from "pg"
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard"

const TAG = "[QB-NIGHTLY-VERIFY]"
const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const REPORT_EMAIL = process.env.QB_REPORT_EMAIL || "a.vargas@ecopowertech.com"
const VERIFY_HOUR = 0  // Run at midnight store-time (America/New_York)
const STORE_TZ = "America/New_York"

// ─── Types ────────────────────────────────────────────────────────────────────

interface SyncLogEntry {
    id: string
    operation: string
    status: string
    order_display_id: number | null
    event_type: string | null
    message: string | null
    qb_txn_id: string | null
    qb_ref_number: string | null
    qb_operation_id: string
    initiated_at: string
}

interface VerificationResult {
    entry: SyncLogEntry
    bridgeStatus: "completed" | "failed" | "pending" | "expired" | "error"
    bridgeRefNumber?: string
    bridgeTxnId?: string
    errorMsg?: string
}

// ─── Bridge helper ────────────────────────────────────────────────────────────

async function checkBridgeStatus(operationId: string): Promise<{
    status: "completed" | "failed" | "pending" | "expired" | "error"
    txnId?: string
    refNumber?: string
    error?: string
}> {
    try {
        const res = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
            method: "GET",
            headers: {
                "x-api-key": API_KEY,
                "bypass-tunnel-reminder": "true",
            },
        })

        if (res.status === 404) return { status: "expired" }
        if (!res.ok) return { status: "error", error: `HTTP ${res.status}` }

        const data = await res.json()
        const op = data?.operation

        if (!op) return { status: "error", error: "No operation in response" }

        if (op.status === "completed") {
            return {
                status: "completed",
                txnId: op.txnId || op.result?.TxnID,
                refNumber: op.refNumber || op.result?.RefNumber,
            }
        }
        if (op.status === "failed") {
            return { status: "failed", error: op.error || "Unknown QB error" }
        }
        // pending / processing / queued
        return { status: "pending" }
    } catch (err: any) {
        return { status: "error", error: err.message }
    }
}

// ─── Email builder ────────────────────────────────────────────────────────────

const OPERATION_LABELS: Record<string, string> = {
    sales_order: "Sales Order",
    estimate: "Estimate",
    payment: "Payment",
    invoice: "Invoice",
    cancel: "Cancellation",
    customer_transfer: "Customer Transfer",
}

function buildEmailHtml(
    results: VerificationResult[],
    confirmed: number,
    failed: number,
    pending: number,
    expired: number,
    reportDate: string
): string {
    const total = results.length

    const statusColor: Record<string, string> = {
        completed: "#22c55e",
        failed: "#ef4444",
        pending: "#f59e0b",
        expired: "#94a3b8",
        error: "#ef4444",
    }

    const statusLabel: Record<string, string> = {
        completed: "✅ Confirmed",
        failed: "❌ Failed",
        pending: "⏳ Still Pending",
        expired: "⚠️ Expired",
        error: "⚠️ Error",
    }

    const rows = results.map(r => {
        const opLabel = OPERATION_LABELS[r.entry.operation] ?? r.entry.operation
        const ref = r.bridgeRefNumber || r.entry.qb_ref_number || "—"
        const orderId = r.entry.order_display_id ? `#${r.entry.order_display_id}` : "—"
        const time = new Date(r.entry.initiated_at).toLocaleString("en-US", {
            timeZone: STORE_TZ, month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: true,
        })
        const color = statusColor[r.bridgeStatus] ?? "#94a3b8"
        const label = statusLabel[r.bridgeStatus] ?? r.bridgeStatus
        const errorText = r.errorMsg ? `<br><small style="color:#ef4444">${r.errorMsg}</small>` : ""

        return `
        <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${opLabel}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${orderId}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:monospace">${ref}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${time}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">
                <span style="color:${color};font-weight:600">${label}</span>${errorText}
            </td>
        </tr>`
    }).join("")

    const hasIssues = failed > 0 || pending > 0
    const headerBg = hasIssues ? "#fef2f2" : "#f0fdf4"
    const headerBorder = hasIssues ? "#fca5a5" : "#86efac"

    return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>QB Nightly Verification Report</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;margin:0;padding:24px">
<div style="max-width:760px;margin:0 auto">

    <!-- Header -->
    <div style="background:#1e293b;border-radius:12px 12px 0 0;padding:24px 28px">
        <h1 style="color:#fff;margin:0;font-size:20px">🔍 QuickBooks Nightly Verification</h1>
        <p style="color:#94a3b8;margin:4px 0 0;font-size:14px">${reportDate}</p>
    </div>

    <!-- Summary cards -->
    <div style="background:${headerBg};border:1px solid ${headerBorder};border-top:none;padding:20px 28px">
        <div style="display:flex;gap:16px;flex-wrap:wrap">
            <div style="background:#fff;border-radius:8px;padding:14px 20px;min-width:120px;text-align:center;border:1px solid #e2e8f0">
                <div style="font-size:28px;font-weight:700;color:#1e293b">${total}</div>
                <div style="font-size:12px;color:#64748b;margin-top:2px">Total Operations</div>
            </div>
            <div style="background:#fff;border-radius:8px;padding:14px 20px;min-width:120px;text-align:center;border:1px solid #e2e8f0">
                <div style="font-size:28px;font-weight:700;color:#22c55e">${confirmed}</div>
                <div style="font-size:12px;color:#64748b;margin-top:2px">✅ Confirmed</div>
            </div>
            <div style="background:#fff;border-radius:8px;padding:14px 20px;min-width:120px;text-align:center;border:1px solid #e2e8f0">
                <div style="font-size:28px;font-weight:700;color:#ef4444">${failed}</div>
                <div style="font-size:12px;color:#64748b;margin-top:2px">❌ Failed</div>
            </div>
            <div style="background:#fff;border-radius:8px;padding:14px 20px;min-width:120px;text-align:center;border:1px solid #e2e8f0">
                <div style="font-size:28px;font-weight:700;color:#f59e0b">${pending}</div>
                <div style="font-size:12px;color:#64748b;margin-top:2px">⏳ Pending</div>
            </div>
            <div style="background:#fff;border-radius:8px;padding:14px 20px;min-width:120px;text-align:center;border:1px solid #e2e8f0">
                <div style="font-size:28px;font-weight:700;color:#94a3b8">${expired}</div>
                <div style="font-size:12px;color:#64748b;margin-top:2px">⚠️ Expired</div>
            </div>
        </div>
        ${hasIssues ? `<p style="color:#dc2626;font-weight:600;margin:16px 0 0">⚡ Action required: ${failed} failed + ${pending} pending operations need review.</p>` : `<p style="color:#16a34a;font-weight:600;margin:16px 0 0">All operations verified successfully. No action required.</p>`}
    </div>

    <!-- Detail table -->
    <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;overflow:hidden">
        ${total > 0 ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
                <tr style="background:#f8fafc">
                    <th style="padding:10px 12px;text-align:left;color:#64748b;font-weight:600;border-bottom:2px solid #e2e8f0">Operation</th>
                    <th style="padding:10px 12px;text-align:left;color:#64748b;font-weight:600;border-bottom:2px solid #e2e8f0">Order</th>
                    <th style="padding:10px 12px;text-align:left;color:#64748b;font-weight:600;border-bottom:2px solid #e2e8f0">QB Ref #</th>
                    <th style="padding:10px 12px;text-align:left;color:#64748b;font-weight:600;border-bottom:2px solid #e2e8f0">Time</th>
                    <th style="padding:10px 12px;text-align:left;color:#64748b;font-weight:600;border-bottom:2px solid #e2e8f0">Status</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>` : `<p style="text-align:center;color:#94a3b8;padding:32px">No QB operations recorded in the last 24 hours.</p>`}
    </div>

    <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:16px">
        EcoPowerTech QuickBooks Integration — Verified at ${reportDate}
    </p>
</div>
</body>
</html>`
}

// ─── Main Job ─────────────────────────────────────────────────────────────────

export default async function qbNightlyVerifyHandler(_container: MedusaContainer) {
    // ── Hour check: only run at VERIFY_HOUR in store timezone ──────────────────
    const now = new Date()
    const currentHour = parseInt(
        new Intl.DateTimeFormat("en-US", {
            hour: "numeric", hour12: false, timeZone: STORE_TZ,
        }).format(now),
        10
    )
    if (currentHour !== VERIFY_HOUR) {
        // Silent skip — runs every 30 min but only executes at midnight
        return
    }

    console.log(`${TAG} 🌙 Starting nightly QB verification...`)

    // ── Guard: QB integration enabled ─────────────────────────────────────────
    if (!(await isQbIntegrationEnabled())) {
        console.log(`${TAG} Integration disabled — skipping.`)
        return
    }

    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        // ── Anti-duplicate: check if today's report already ran ──────────────
        const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: STORE_TZ }).format(now)
        const { rows: alreadyRan } = await client.query(`
            SELECT id FROM qb_sync_log
            WHERE operation = 'nightly_verify'
              AND initiated_at >= NOW() - INTERVAL '2 hours'
            LIMIT 1
        `)
        if (alreadyRan.length > 0) {
            console.log(`${TAG} Already ran today — skipping.`)
            return
        }

        // ── Query all order-level operations from the past 24h with operationId ──
        const { rows: entries } = await client.query<SyncLogEntry>(`
            SELECT
                id, operation, status, order_display_id, event_type,
                message, qb_txn_id, qb_ref_number, qb_operation_id, initiated_at
            FROM qb_sync_log
            WHERE operation IN ('sales_order','invoice','cancel','payment','estimate','customer_transfer')
              AND qb_operation_id IS NOT NULL
              AND initiated_at >= NOW() - INTERVAL '24 hours'
            ORDER BY initiated_at DESC
        `)

        console.log(`${TAG} Found ${entries.length} operations to verify.`)

        // ── Verify each entry against the bridge ────────────────────────────────
        const results: VerificationResult[] = []
        let confirmed = 0, failed = 0, pending = 0, expired = 0

        for (const entry of entries) {
            const bridge = await checkBridgeStatus(entry.qb_operation_id)

            const result: VerificationResult = {
                entry,
                bridgeStatus: bridge.status,
                bridgeRefNumber: bridge.refNumber,
                bridgeTxnId: bridge.txnId,
                errorMsg: bridge.error,
            }
            results.push(result)

            switch (bridge.status) {
                case "completed":
                    confirmed++
                    // Update ref number if we got new data from bridge
                    if (bridge.refNumber && !entry.qb_ref_number) {
                        await client.query(
                            `UPDATE qb_sync_log SET qb_ref_number = $1, qb_txn_id = COALESCE(qb_txn_id, $2) WHERE id = $3`,
                            [bridge.refNumber, bridge.txnId ?? null, entry.id]
                        )
                    }
                    break
                case "failed":
                    failed++
                    // Retroactively mark as failed if it was logged as completed
                    if (entry.status === "completed") {
                        await client.query(
                            `UPDATE qb_sync_log SET status = 'failed', error = $1 WHERE id = $2`,
                            [`[Nightly verify] QB operation actually failed: ${bridge.error}`, entry.id]
                        )
                    }
                    break
                case "pending":
                    pending++
                    break
                case "expired":
                case "error":
                    expired++
                    break
            }

            // Small delay to avoid hammering the bridge
            await new Promise(r => setTimeout(r, 300))
        }

        // ── Build report date string ─────────────────────────────────────────────
        const reportDate = now.toLocaleString("en-US", {
            timeZone: STORE_TZ, weekday: "long", year: "numeric",
            month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
        })

        // ── Send email digest ────────────────────────────────────────────────────
        const hasIssues = failed > 0 || pending > 0
        const subject = hasIssues
            ? `⚠️ QB Nightly Report — ${failed} Failed, ${pending} Pending (${todayStr})`
            : `✅ QB Nightly Report — All Clear (${todayStr})`

        const html = buildEmailHtml(results, confirmed, failed, pending, expired, reportDate)

        try {
            const { sendMail } = await import("../utils/mailer")
            await sendMail({ to: REPORT_EMAIL, subject, html })
            console.log(`${TAG} ✅ Report emailed to ${REPORT_EMAIL}`)
        } catch (emailErr: any) {
            console.error(`${TAG} ❌ Failed to send email: ${emailErr.message}`)
        }

        // ── Log this run in qb_sync_log so anti-duplicate check works ───────────
        await client.query(`
            INSERT INTO qb_sync_log (operation, status, message, completed_at, initiated_at, server_host)
            VALUES ('nightly_verify', 'completed', $1, NOW(), NOW(), $2)
        `, [
            `Verified ${entries.length} operations: ${confirmed} confirmed, ${failed} failed, ${pending} pending, ${expired} expired`,
            process.env.RAILWAY_SERVICE_NAME
                ? `Railway:${process.env.RAILWAY_SERVICE_NAME}`
                : require("os").hostname(),
        ])

        console.log(`${TAG} 🏁 Done. Confirmed: ${confirmed} | Failed: ${failed} | Pending: ${pending} | Expired: ${expired}`)

    } catch (err: any) {
        console.error(`${TAG} Job outer failure: ${err.message}`)
    } finally {
        await client.end()
    }
}

/**
 * Medusa scheduled job config.
 * Fires every 30 minutes — midnight check done internally.
 */
export const config = {
    name: "quickbooks-nightly-verify",
    schedule: "*/30 * * * *",
}
