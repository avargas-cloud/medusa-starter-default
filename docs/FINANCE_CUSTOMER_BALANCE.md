# Finance Customer Balance y Credit Statements
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

El sistema de balance de cliente funciona como el AR de QuickBooks: calcula cuanto debe un cliente y cuanto credito tiene disponible en tiempo real. Permite al staff ver el estado de cuenta completo de cualquier cliente antes de procesar un pago.

---

## Formula del Balance

```
Net Balance = creditos_disponibles - deuda_abierta

Donde:
  creditos_disponibles = SUM(CustomerPayment.amount) - SUM(PaymentApplication.amount_applied activas)
                         (solo pagos no voided, no refunded)

  deuda_abierta = SUM(PosInvoice.balance_due)
                  (solo invoices con status != 'voided' y != 'paid')
```

Un balance **negativo** = cliente debe dinero (AR outstanding).
Un balance **positivo** = cliente tiene credito disponible (overpayment o deposito).

---

## API

### GET /admin/finance/customers/:id/balance

Retorna el balance neto del cliente con detalle de cada componente.

**Response:**
```json
{
    "customer_id": "cus_...",
    "customer": {
        "id": "cus_...",
        "email": "cliente@ejemplo.com",
        "first_name": "Juan",
        "last_name": "Garcia",
        "company_name": "Garcia Distribuciones"
    },
    "available_credits": 150000,
    "outstanding_invoices": 75000,
    "net_balance": 75000,
    "invoices": [
        {
            "id": "...",
            "invoice_number": "INV-1234-1",
            "total": 100000,
            "amount_paid": 25000,
            "balance_due": 75000,
            "status": "partial"
        }
    ],
    "payments": [
        {
            "id": "cpay_...",
            "display_id": 2016,
            "amount": 200000,
            "available_balance": 150000,
            "method": "check",
            "status": "partially_applied",
            "received_at": "..."
        }
    ]
}
```

---

## Estado de Cuenta (Finance Statement)

El estado de cuenta completo del cliente incluye:
- Todos los `CustomerPayment` (pagos recibidos, creditos de devoluciones)
- Todos los `PosInvoice` (facturas emitidas)
- Las `PaymentApplication` (como se aplicaron los pagos a las facturas)
- Balance neto en tiempo real

Esto es equivalente al "Customer Center" de QuickBooks.

---

## Credit Ledger Legacy

Existe una tabla legacy `customer_credit_ledger` que fue el primer intento de AR tracking. Ya no se usa en el codigo nuevo -- el Finance module (`CustomerPayment` + `PaymentApplication`) la reemplaza completamente.

Si se encuentran referencias a `customer_credit_ledger` en el codigo, son legacy y pueden ignorarse para el flujo actual.

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| Balance API | `src/api/admin/finance/customers/[id]/balance/route.ts` | Calculo de balance |
| CustomerPayment | `src/modules/finance/models/customer-payment.ts` | Fuente de creditos |
| PaymentApplication | `src/modules/finance/models/payment-application.ts` | Consumo de creditos |
| PosInvoice | `src/modules/invoices/models/pos-invoice.ts` | Fuente de deudas |
