#!/usr/bin/env python3
"""E2E — un PO reparte sus cantidades entre varios Regular Vendor Bills.

Contra el sandbox (9099). No toca QuickBooks: los drafts nunca se confirman,
y el script asserta que el pipeline de QB no creció.

Sale 0 si los 5 casos pasan, 1 si alguno falla.
"""
import json
import subprocess
import sys
import urllib.request
import urllib.error

BASE = "http://localhost:9099"
PO_ID = "po_01KY7RHBK5EBAMR9W9ADZFD6X8"
PO_NUMBER = "PO-1123"
VENDOR_ID = "qbvnd_01KPGGQBTH5QPS21D520X2FEYE"

failures = []
created_bill_ids = []


def psql(sql):
    out = subprocess.run(
        ["psql", "-h", "localhost", "-p", "5499", "-U", "postgres",
         "-d", "medusa", "-A", "-t", "-c", sql],
        capture_output=True, text=True, env={"PGPASSWORD": "sandbox", "PATH": "/usr/bin:/bin"},
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr)
    return out.stdout.strip()


def api(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return e.code, {"raw": raw.decode(errors="replace")}


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"\n        {detail}" if detail else ""))
    if not ok:
        failures.append(name)
    return ok


def cleanup():
    """Borra los bills de corridas previas para que el E2E sea repetible.

    Hace falta de verdad: el mutation test corre el mismo escenario dos veces,
    y un bill A sobreviviente reclamaría el PO entero, con lo que la segunda
    corrida mediría otra cosa."""
    psql("""
      DELETE FROM vendor_bill_line WHERE vendor_bill_id IN (
        SELECT id FROM vendor_bill WHERE reference_id LIKE 'E2E-PARTIAL-%');
      DELETE FROM vendor_bill WHERE reference_id LIKE 'E2E-PARTIAL-%';""")


def main():
    token = open(sys.argv[1]).read().strip()
    cleanup()
    qb_before = int(psql("SELECT count(*) FROM qb_vendor_bill_pipeline;"))

    # ── Caso 1: bill A desde el PO, con cantidades reducidas ────────────────
    status, body = api("POST", f"/admin/purchase-orders/{PO_ID}/vendor-bill", token, {
        "reference_id": "E2E-PARTIAL-A",
        "commission_mode": "percent",
    })
    if not check("1a. bill A creado desde el PO", status == 201, f"HTTP {status} {json.dumps(body)[:300]}"):
        sys.exit(1)
    bill_a = body["vendor_bill"]
    created_bill_ids.append(bill_a["id"])
    lines_a = bill_a["lines"]
    seeded_a = sum(int(l["qty"]) for l in lines_a)
    check("1b. bill A se sembró con las 90 unidades del PO entero",
          seeded_a == 90 and len(lines_a) == 8,
          f"{len(lines_a)} líneas, {seeded_a} unidades")

    # El vendor factura una entrega parcial: se deja 1 unidad en las dos
    # primeras líneas y el resto en cero, igual que hizo el operador en VB-1076.
    keep = {lines_a[0]["id"]: 1, lines_a[1]["id"]: 1}
    payload_lines = [{
        "id": l["id"],
        "purchase_order_line_id": l["purchase_order_line_id"],
        "product_variant_id": l["product_variant_id"],
        "sku": l["sku"],
        "description": l["description"],
        "qty": keep.get(l["id"], 0),
        "unit_cost_cents": int(l["unit_cost_cents"]),
    } for l in lines_a]
    status, body = api("PATCH", f"/admin/vendor-bills/{bill_a['id']}", token, {"lines": payload_lines})
    check("1c. bill A guardado como parcial (2 de 90 unidades)",
          status == 200, f"HTTP {status} {json.dumps(body)[:300]}")

    billed_a = int(psql(
        "SELECT COALESCE(SUM(qty),0) FROM vendor_bill_line "
        f"WHERE vendor_bill_id='{bill_a['id']}' AND deleted_at IS NULL "
        "AND COALESCE(line_type,'product')='product';"))
    check("1d. la DB confirma 2 unidades facturadas en bill A", billed_a == 2, f"qty total = {billed_a}")

    # ── Caso 2: el PO sigue disponible en el picker, con su remanente ───────
    status, po_list = api("GET", f"/admin/purchase-orders?vendor_id={VENDOR_ID}&limit=200", token)
    po_row = next((p for p in po_list.get("purchase_orders", []) if p["id"] == PO_ID), None)
    status2, bill_list = api("GET", "/admin/vendor-bills?bill_type=regular&limit=200", token)
    documented = sum(
        int(b.get("product_qty") or 0)
        for b in bill_list.get("vendor_bills", [])
        if b.get("purchase_order_id") == PO_ID and b.get("status") in ("draft", "confirmed", "synced"))
    remaining_ui = (po_row["total_units_ordered"] - documented) if po_row else -1
    # Esto es exactamente lo que computa el picker: si da > 0, el PO se
    # muestra y "Use PO" queda habilitado. Antes el PO se ocultaba por tener
    # un bill, sin mirar cantidades.
    check("2. el picker ve el PO con 88 de 90 unidades sin facturar",
          po_row is not None and po_row.get("billed_status") != "yes" and remaining_ui == 88,
          f"ordered={po_row['total_units_ordered'] if po_row else '?'} documented={documented} remaining={remaining_ui}")

    # ── Caso 3: bill B trae SOLO el remanente ───────────────────────────────
    status, body = api("POST", f"/admin/purchase-orders/{PO_ID}/vendor-bill", token, {
        "reference_id": "E2E-PARTIAL-B",
        "commission_mode": "percent",
    })
    if not check("3a. bill B creado desde el MISMO PO (antes: 409 po_regular_bill_exists)",
                 status == 201, f"HTTP {status} {json.dumps(body)[:300]}"):
        sys.exit(1)
    bill_b = body["vendor_bill"]
    created_bill_ids.append(bill_b["id"])
    lines_b = bill_b["lines"]
    seeded_b = sum(int(l["qty"]) for l in lines_b)
    check("3b. bill B se sembró con el remanente (88), no con el PO entero (90)",
          seeded_b == 88, f"{len(lines_b)} líneas, {seeded_b} unidades")

    # Cuánto retuvo bill A por LÍNEA DE PO (post-save), y qué ordenó el PO.
    kept_by_pol = {l["purchase_order_line_id"]: keep.get(l["id"], 0) for l in lines_a}
    ordered_by_pol = dict(
        row.split("|") for row in psql(
            "SELECT id||'|'||GREATEST(qty_ordered-COALESCE(qty_cancelled,0),0) "
            f"FROM purchase_order_line WHERE purchase_order_id='{PO_ID}' "
            "AND deleted_at IS NULL;").splitlines())
    ordered_by_pol = {k: int(v) for k, v in ordered_by_pol.items()}
    by_pol_b = {l["purchase_order_line_id"]: int(l["qty"]) for l in lines_b}

    # Las 2 líneas que bill A retuvo tienen que llegar a bill B exactamente
    # con lo ordenado MENOS lo retenido; el resto, completas.
    exact = {p: ordered_by_pol[p] - kept_by_pol.get(p, 0) for p in ordered_by_pol}
    mismatched = {p: (by_pol_b.get(p, 0), exact[p]) for p in exact
                  if by_pol_b.get(p, 0) != exact[p]}
    check("3c. cada línea de bill B trae ordenado − lo que bill A retuvo",
          not mismatched,
          "ok" if not mismatched else "difieren: " + ", ".join(
              f"{p[-8:]} B={g} esperado={e}" for p, (g, e) in mismatched.items()))

    # La invariante que todo esto protege, línea por línea.
    over = {p: (kept_by_pol.get(p, 0) + by_pol_b.get(p, 0), ordered_by_pol[p])
            for p in ordered_by_pol
            if kept_by_pol.get(p, 0) + by_pol_b.get(p, 0) > ordered_by_pol[p]}
    check("3d. A + B nunca supera lo ordenado en NINGUNA línea",
          not over,
          "ok" if not over else "sobrepasan: " + ", ".join(
              f"{p[-8:]} {s}>{o}" for p, (s, o) in over.items()))

    # ── Caso 4: pasarse del remanente es rechazado ──────────────────────────
    # El objetivo se elige por NOMBRE, no por posición: tiene que ser una línea
    # que bill A esté reteniendo, o pedir lo ordenado no supera nada y un 200
    # sería la respuesta correcta. (El orden de las líneas no es estable entre
    # corridas, así que `lines_b[0]` hacía el test intermitente.)
    contested = [p for p, kept in kept_by_pol.items() if kept > 0]
    if not check("4-pre. hay una línea que bill A retiene, para disputarla",
                 bool(contested)):
        sys.exit(1)
    po_line = contested[0]
    target = next(l for l in lines_b if l["purchase_order_line_id"] == po_line)
    ordered_here = ordered_by_pol[po_line]
    status, body = api("PATCH", f"/admin/vendor-bills/{bill_b['id']}", token, {
        "line_quantities": [{"id": target["id"], "qty": ordered_here}],
    })
    rejected = status == 422 and body.get("code") == "qty_exceeds_po"
    names_sibling = "E2E" not in str(body.get("error", "")) and (
        body.get("billed_on") is not None or "already billed" in str(body.get("error", "")))
    check("4a. pedir la cantidad ORDENADA completa en bill B es rechazado (422)",
          rejected, f"HTTP {status} {json.dumps(body)[:300]}")
    check("4b. el error nombra el bill que retiene la diferencia",
          rejected and names_sibling, f"error={body.get('error')} billed_on={body.get('billed_on')}")
    check("4c. quedarse EN el remanente sí se acepta",
          api("PATCH", f"/admin/vendor-bills/{bill_b['id']}", token,
              {"line_quantities": [{"id": target["id"], "qty": int(target["qty"])}]})[0] == 200)

    # ── Caso 5: nada llegó a QuickBooks ─────────────────────────────────────
    qb_after = int(psql("SELECT count(*) FROM qb_vendor_bill_pipeline;"))
    statuses = psql(
        "SELECT string_agg(DISTINCT status, ',') FROM vendor_bill WHERE id IN ("
        + ",".join(f"'{b}'" for b in created_bill_ids) + ");")
    check("5a. los dos bills quedaron en draft", statuses == "draft", f"status = {statuses}")
    check("5b. el pipeline de QuickBooks no creció", qb_after == qb_before,
          f"{qb_before} → {qb_after} filas")

    # Invariante global, la misma que audita el verify de producción.
    over = psql("""
      SELECT COALESCE(count(*),0) FROM (
        SELECT pol.id FROM purchase_order_line pol
        JOIN vendor_bill_line vbl ON vbl.purchase_order_line_id=pol.id AND vbl.deleted_at IS NULL
          AND COALESCE(vbl.line_type,'product')='product'
        JOIN vendor_bill vb ON vb.id=vbl.vendor_bill_id AND vb.deleted_at IS NULL
          AND vb.bill_type='regular' AND vb.status IN ('draft','confirmed','synced')
        WHERE pol.deleted_at IS NULL
        GROUP BY pol.id, pol.qty_ordered, pol.qty_cancelled
        HAVING SUM(COALESCE(vbl.qty,0)) > GREATEST(pol.qty_ordered-COALESCE(pol.qty_cancelled,0),0)
      ) t;""")
    check("5c. ninguna línea de PO quedó sobre-facturada en toda la base", over == "0", f"{over} líneas")

    print()
    if failures:
        print(f"{len(failures)} FALLA(S): " + "; ".join(failures))
        sys.exit(1)
    print("E2E PASS — los 5 casos.")


if __name__ == "__main__":
    main()
