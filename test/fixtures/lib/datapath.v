// Datapath: instantiates adder + regfile and wires them together.
module datapath #(
  parameter int WIDTH = 8,
  parameter int DEPTH = 4
) (
  input  wire              clk,
  input  wire              rst_n,
  input  wire [WIDTH-1:0]  a,
  input  wire [WIDTH-1:0]  b,
  input  wire              cin,
  input  wire              we,
  input  wire [1:0]        waddr,
  input  wire [1:0]        raddr,
  output wire [WIDTH-1:0]  result,
  output wire              carry
);

  localparam int AW = 2;

  wire [WIDTH-1:0] alu_sum;
  wire             alu_cout;
  wire [WIDTH-1:0] rf_rdata;
  wire [WIDTH-1:0] stage_in;

  // stage_in selects between the adder output and the register file output.
  assign stage_in = alu_cout ? rf_rdata : alu_sum;

  adder #(
    .WIDTH (WIDTH)
  ) u_adder (
    .clk   (clk),
    .rst_n (rst_n),
    .a     (a),
    .b     (b),
    .cin   (cin),
    .sum   (alu_sum),
    .cout  (alu_cout)
  );

  regfile #(
    .DEPTH (DEPTH),
    .WIDTH (WIDTH)
  ) u_regfile (
    .clk    (clk),
    .rst_n  (rst_n),
    .we     (we),
    .waddr  (waddr),
    .wdata  (alu_sum),
    .re     (1'b1),
    .raddr  (raddr),
    .rdata  (rf_rdata)
  );

  assign result = stage_in;
  assign carry  = alu_cout;

endmodule
