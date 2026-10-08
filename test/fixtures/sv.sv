// SystemVerilog: ANSI ports, interfaces, packages, typed signals, local fns.
package types_pkg;
  typedef enum logic [1:0] { IDLE, RUN, DONE } state_e;
  parameter int unsigned MAX = 32;
endpackage

interface bus_if #(parameter DW = 32) (input logic clk);
  logic [DW-1:0] data;
  logic          valid, ready;
  modport master (output data, output valid, input ready);
  modport slave  (input data, input valid, output ready);
endinterface

module alu #(
  parameter int WIDTH = 8,
  parameter type T = logic [WIDTH-1:0]
) (
  input  var logic         clk,
  input  var logic         rst_n,
  input  var T             a,
  input  var T             b,
  input  var logic [1:0]   op,
  output var T             y,
  output var logic         zero
);

  import types_pkg::*;

  typedef enum logic [1:0] { ADD, SUB, MUL } op_e;
  op_e                     op_q;
  logic [WIDTH:0]          acc;
  types_pkg::state_e       phase;
  bit                      [7:0] shadow [0:3];
  localparam int DOUBLE_W = WIDTH * 2;
  localparam int CLG      = $clog2(WIDTH);

  function automatic logic [WIDTH-1:0] add2(input logic [WIDTH-1:0] x,
                                           input logic [WIDTH-1:0] z);
    return x + z;
  endfunction

  function automatic int clog(input int v);
    int t;
    t = 0;
    while (v > 1) begin
      v = v >> 1;
      t = t + 1;
    end
    return t;
  endfunction

  task automatic bump(input int n);
    acc = acc + n;
  endtask

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      acc  <= '0;
      zero <= 1'b0;
    end else begin
      acc  <= add2(a, b);
      zero <= (acc == '0);
      op_q <= op_e'(op);
      case (op)
        ADD: y = a + b;
        SUB: y = a - b;
        default: y = '0;
      endcase
    end
  end

  assign shadow[0] = 8'(y[7:0]);

endmodule

module soc (
  input  logic         clk,
  input  logic         rst_n,
  bus_if.slave         bus,
  output logic [31:0]  wb_data,
  output logic         wb_valid
);

  localparam int DATA_W = 32;

  logic [DATA_W-1:0] alu_out;
  logic              alu_zero;
  logic [1:0]        alu_op;
  wire  [31:0]       bus_data;
  wire               bus_valid;

  // Parameter in the module header, and reads that go into the generate blocks
  // of the instance. The index in a hierarchical path is what tells the
  // iterations and the elements apart, so each of these is its own signal.
  wire  [1:0] lane_hit;
  wire        lane_pair;
  wire        lane_tag;

  gen_lane #(.LANES (2)) u_lane (
    .clk (clk),
    .en  (rst_n),
    .hit (lane_hit)
  );

  assign lane_pair = u_lane.ln[1].half[0].pair[0];
  assign lane_tag  = u_lane.many.u[2].dout;

  alu #(.WIDTH(DATA_W)) u_alu (
    .clk   (clk),
    .rst_n (rst_n),
    .a     (bus_data),
    .b     (32'hDEAD_BEEF),
    .op    (alu_op),
    .y     (alu_out),
    .zero  (alu_zero)
  );

  assign bus.valid = bus_valid;
  assign bus_data  = wb_data;
  assign wb_data   = alu_out;
  assign wb_valid  = alu_zero & bus.ready & (&lane_hit) & lane_pair & lane_tag;

endmodule
