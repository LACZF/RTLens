// Top level: instantiates the datapath and a control block.
module chip_top (
  input  wire        clk,
  input  wire        rst_n,
  input  wire [7:0]  operand_a,
  input  wire [7:0]  operand_b,
  input  wire        cin,
  input  wire        start,
  output wire [7:0]  result,
  output wire        carry,
  output wire        busy
);

  wire        op_we;
  wire [1:0]  op_waddr;
  wire [1:0]  op_raddr;
  wire        dp_carry;

  control u_ctrl (
    .clk    (clk),
    .rst_n  (rst_n),
    .start  (start),
    .busy   (busy),
    .op_we  (op_we),
    .op_wad (op_waddr),
    .op_rad (op_raddr)
  );

  datapath #(
    .WIDTH (8),
    .DEPTH (4)
  ) u_dpath (
    .clk     (clk),
    .rst_n   (rst_n),
    .a       (operand_a),
    .b       (operand_b),
    .cin     (cin),
    .we      (op_we),
    .waddr   (op_waddr),
    .raddr   (op_raddr),
    .result  (result),
    .carry   (dp_carry)
  );

  assign carry = dp_carry;

endmodule
