/** The HTTP-shaped failure shared by the approval service and the deploy gate. */
export interface ApprovalServiceFailure {
  status: number;
  code: string;
  error: string;
}
