// Adder with a registered output; leaf module.
module adder #(
  parameter int WIDTH = 8
) (
  input  wire              clk,
  input  wire              rst_n,
  input  wire [WIDTH-1:0]  a,
  input  wire [WIDTH-1:0]  b,
  input  wire              cin,
  output wire [WIDTH-1:0]  sum,
  output wire              cout
);

  wire [WIDTH:0] full_sum;

  assign full_sum = {1'b0, a} + {1'b0, b} + {{WIDTH{1'b0}}, cin};
  assign sum  = full_sum[WIDTH-1:0];
  assign cout = full_sum[WIDTH];

endmodule
