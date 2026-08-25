import { BuyerApproval } from "./buyer-approval";

export default async function ApprovalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <BuyerApproval token={token} />;
}
