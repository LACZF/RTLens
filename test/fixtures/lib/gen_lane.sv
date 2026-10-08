// Parameter in the module header, nested generate blocks, branch labels and an
// arrayed instantiation - the shapes whose paths have to stay distinct.
module gen_leaf (
  input  wire din,
  output wire dout
);
  assign dout = ~din;
endmodule

module gen_lane (parameter int LANES = 2, input wire clk, input wire en, output wire [LANES-1:0] hit);
  localparam int BITS = LANES * 2;

  wire [BITS-1:0] w;
  wire [BITS-1:0] q;

  genvar l, b;
  generate
    for (l = 0; l < LANES; l = l + 1) begin : ln
      for (b = 0; b < 2; b = b + 1) begin : half
        wire [1:0] pair;
        assign pair = {en, clk};
        assign hit[l] = &pair;
      end
    end
  endgenerate

  // The same name declared in both branches of a generate if: each read has to
  // find its own copy. An arrayed instance lives in the `many` branch, so
  // `u_lane.many.u[2].dout` is a branch, an element and a port in one path.
  generate
    if (LANES > 1) begin : many
      wire tag;
      gen_leaf u [3:0] (.din (clk), .dout (w[3:0]));
      assign tag = w[0];
    end else begin : one
      wire tag;
      gen_leaf u (clk, q[0]);
      assign tag = q[0];
    end
  endgenerate

  assign q[BITS-1:1] = w[BITS-1:1];
endmodule
