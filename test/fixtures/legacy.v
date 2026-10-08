// Verilog-1995 / 2001 non-ANSI style, generate loops, macros, defparam.
`timescale 1ns / 1ps
`define WIDTH 8

module fifo #(
  parameter DEPTH = 16,
  parameter WIDTH = 8
) (
  clk,
  rst_n,
  wr_en,
  wr_data,
  full,
  rd_en,
  rd_data,
  empty
);

  input              clk;
  input              rst_n;
  input              wr_en;
  input  [WIDTH-1:0] wr_data;
  output             full;
  input              rd_en;
  output [WIDTH-1:0] rd_data;
  output             empty;

  reg [WIDTH-1:0] mem [0:DEPTH-1];
  reg [4:0]       wptr, rptr;
  wire            do_write = wr_en & ~full;
  wire            do_read  = rd_en & ~empty;

  reg [1:0] state;

  // Sub-blocks instantiated in parallel.
  wire [WIDTH-1:0] wdata_s;

  store #(.DW(WIDTH)) u_store (
    .clk   (clk),
    .en    (do_write),
    .din   (wr_data),
    .dout  (wdata_s)
  );

  readport #(.DW(WIDTH)) u_rd (
    .clk  (clk),
    .en   (do_read),
    .din  (mem[rptr]),
    .dout (rd_data)
  );

  genvar gi;
  generate
    for (gi = 0; gi < 4; gi = gi + 1) begin : g_par
      parity u_par (
        .clk (clk),
        .d   (wdata_s[gi]),
        .q   ()
      );
    end
  endgenerate

  // Two instances in one statement.
  sync2 #(.N(2)) u_sync (.clk(clk), .rst_n(rst_n)),
                    u_sy2 (.clk(clk), .rst_n(rst_n));

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      wptr <= 5'b0;
      rptr <= 5'b0;
      full <= 1'b0;
      empty <= 1'b1;
    end
    else begin
      if (do_write) wptr <= wptr + 1'b1;
      if (do_read)  rptr <= rptr + 1'b1;
      full  <= (wptr == DEPTH[4:0] - 5'd1);
      empty <= (rptr == wptr);
    end
  end

  assign {full, empty} = (wptr[4] ^ rptr[4]) ? {wptr[4], ~rptr[4]} : {wptr[4], rptr[4]};

endmodule
