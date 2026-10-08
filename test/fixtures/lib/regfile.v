// Register file: a generate-for array of single-bit registers.
`include "chip_cfg.sv"
import chip_cfg::byte_t;

module regfile #(
  parameter int DEPTH = 4,
  parameter int WIDTH = 8
) (
  input  wire              clk,
  input  wire              rst_n,
  input  wire              we,
  input  wire [$clog2(DEPTH)-1:0] waddr,
  input  wire [WIDTH-1:0]  wdata,
  input  wire              re,
  input  wire [$clog2(DEPTH)-1:0] raddr,
  output wire [WIDTH-1:0]  rdata
);

  // An implicit wire: no `wire w;` anywhere, Verilog declares it from the
  // continuous assignment.
  assign unused_pulse = clk & we;

  wire [WIDTH-1:0] regs [0:DEPTH-1];

  genvar i;
  generate
    for (i = 0; i < DEPTH; i = i + 1) begin : g_reg
      wire hit_w = we && (waddr == i[$clog2(DEPTH)-1:0]);
      wire hit_r = re && (raddr == i[$clog2(DEPTH)-1:0]);

      always @(posedge clk or negedge rst_n) begin
        if (!rst_n)      regs[i] <= {WIDTH{1'b0}};
        else if (hit_w)  regs[i] <= wdata;
      end

      assign rdata = hit_r ? regs[i] : {WIDTH{1'b0}};
    end
  endgenerate

endmodule
