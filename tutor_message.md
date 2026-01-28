ago

Review
Medusa v2 Subscriber Loading Bug
Critical Bug Discovered
After clean reinstall and extensive debugging (3+ hours), we've identified a critical architectural bug in Medusa v2's subscriber loading system.

The Problem
Medusa v2's subscriber loader searches the wrong directory:

❌ Searches:  node_modules/@medusajs/draft-order/.medusa/server/src/subscribers/
✅ Should search: .medusa/server/src/subscribers/ (project root)
Evidence
✅ Subscribers compile correctly to .medusa/server/src/subscribers/

wildcard.js exists at correct path
protect-managed-options.js exists at correct path
✅ Build completes successfully

Backend: 3.05s
Frontend: 10.86s
No compilation errors
❌ Runtime loader fails

info: No subscriber to load from .../node_modules/@medusajs/draft-order/.medusa/server/src/subscribers. skipped.
❌ Never searches project root

Even after deleting node_modules/@medusajs/draft-order/.medusa/
Hardcoded path in Medusa core
Impact
Local Development: Subscribers don't load at all
Railway Production: Same issue - subscribers load but don't process events
Workaround Attempts: All failed due to hardcoded loader path
Root Cause
The bug is in Medusa's core subscriber loader (@medusajs/framework/src/subscribers/subscriber-loader.ts), which only searches package directories in node_modules and ignores the project root .medusa build output.

Options
Option A: Abandon automatic event-driven sync (Recommended)

Manual sync button works perfectly
System is 100% functional
No dependency on broken Medusa feature
Option B: Report bug and wait for official fix

Open GitHub issue on medusajs/medusa
Wait 1-2 days minimum for response
Continue using manual sync meanwhile
Option C: Patch Medusa core (High risk)

Modify node_modules/@medusajs/framework source
Breaks on every yarn install
Unsupported and fragile
Recommendation
Choose Option A - the manual sync button is reliable, fast, and doesn't require hacking Medusa's