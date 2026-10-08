// Testbench: exercises chip_top and reaches into the hierarchy.
`timescale 1ns/1ps
module tb_chip_top;

  reg         clk;
  reg         rst_n;
  reg  [7:0]  operand_a, operand_b;
  reg         cin, start;
  wire [7:0]  result;
  wire        carry, busy;

  chip_top dut (
    .clk       (clk),
    .rst_n     (rst_n),
    .operand_a (operand_a),
    .operand_b (operand_b),
    .cin       (cin),
    .start     (start),
    .result    (result),
    .carry     (carry),
    .busy      (busy)
  );

  // Hierarchical references - these are the interesting jump targets.
  wire [7:0] peek_sum   = dut.u_dpath.alu_sum;
  wire       peek_carry = dut.u_dpath.alu_cout;
  wire [7:0] peek_rf    = dut.u_dpath.rf_rdata;
  wire [7:0] peek_mem   = dut.u_dpath.u_regfile.regs[0];

  initial clk = 1'b0;
  always #5 clk = ~clk;

  initial begin
    rst_n = 1'b0;
    start = 1'b0;
    cin   = 1'b0;
    @(negedge clk);
    rst_n = 1'b1;
    operand_a = 8'h12;
    operand_b = 8'h34;
    #20 start = 1'b1;
    #40 $display("sum=%h carry=%b", result, carry);
    $finish;
  end

endmodule
