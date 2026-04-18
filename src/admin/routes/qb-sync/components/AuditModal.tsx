import { Heading, Text, Button } from "@medusajs/ui";

type AuditModalProps = {
  auditData: any;
  onClose: () => void;
};

export const AuditModal = ({ auditData, onClose }: AuditModalProps) => {
  if (!auditData) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg p-6 max-w-4xl max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <Heading level="h2">Customer Audit Report</Heading>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-gray-50 rounded">
              <Text className="text-sm text-gray-600">Total in QB</Text>
              <Text className="text-2xl font-bold">
                {auditData.stats.totalInQb}
              </Text>
            </div>
            <div className="p-4 bg-gray-50 rounded">
              <Text className="text-sm text-gray-600">Total in Medusa</Text>
              <Text className="text-2xl font-bold">
                {auditData.stats.totalInMedusa}
              </Text>
            </div>
            <div className="p-4 bg-gray-50 rounded">
              <Text className="text-sm text-gray-600">In Both</Text>
              <Text className="text-2xl font-bold">
                {auditData.stats.inBoth}
              </Text>
            </div>
          </div>

          <div>
            <Heading level="h3" className="mb-2">
              Only in QuickBooks ({auditData.stats.onlyInQb})
            </Heading>
            {auditData.customersOnlyInQb.length > 0 ? (
              <div className="overflow-x-auto max-h-60 overflow-y-auto border rounded">
                <table className="min-w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="p-2 text-left text-xs">Name</th>
                      <th className="p-2 text-left text-xs">Email</th>
                      <th className="p-2 text-left text-xs">Company</th>
                      <th className="p-2 text-left text-xs">Price Level</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditData.customersOnlyInQb
                      .slice(0, 50)
                      .map((c: any, i: number) => (
                        <tr key={i} className="border-t">
                          <td className="p-2 text-sm">{c.Name}</td>
                          <td className="p-2 text-sm">{c.Email || "-"}</td>
                          <td className="p-2 text-sm">
                            {c.CompanyName || "-"}
                          </td>
                          <td className="p-2 text-sm">{c.PriceLevel}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {auditData.customersOnlyInQb.length > 50 && (
                  <Text className="p-2 text-xs text-gray-500">
                    Showing first 50 of {auditData.customersOnlyInQb.length}
                  </Text>
                )}
              </div>
            ) : (
              <Text className="text-gray-500">
                No customers found only in QuickBooks
              </Text>
            )}
          </div>

          <div>
            <Heading level="h3" className="mb-2">
              Only in Medusa ({auditData.stats.onlyInMedusa})
            </Heading>
            {auditData.customersOnlyInMedusa.length > 0 ? (
              <div className="overflow-x-auto max-h-60 overflow-y-auto border rounded">
                <table className="min-w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="p-2 text-left text-xs">Email</th>
                      <th className="p-2 text-left text-xs">Name</th>
                      <th className="p-2 text-left text-xs">QB List ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditData.customersOnlyInMedusa
                      .slice(0, 50)
                      .map((c: any, i: number) => (
                        <tr key={i} className="border-t">
                          <td className="p-2 text-sm">{c.email}</td>
                          <td className="p-2 text-sm">
                            {c.first_name || ""} {c.last_name || ""}
                          </td>
                          <td className="p-2 text-sm font-mono text-xs">
                            {c.qb_list_id}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {auditData.customersOnlyInMedusa.length > 50 && (
                  <Text className="p-2 text-xs text-gray-500">
                    Showing first 50 of {auditData.customersOnlyInMedusa.length}
                  </Text>
                )}
              </div>
            ) : (
              <Text className="text-gray-500">
                No customers found only in Medusa
              </Text>
            )}
          </div>

          <Text className="text-xs text-gray-500">
            Last checked: {new Date(auditData.lastCheckAt).toLocaleString()}
          </Text>
        </div>
      </div>
    </div>
  );
};
