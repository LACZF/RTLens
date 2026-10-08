// Control block with a small FSM.
module control (
  input  wire       clk,
  input  wire       rst_n,
  input  wire       start,
  output reg        busy,
  output reg        op_we,
  output reg [1:0]  op_wad,
  output reg [1:0]  op_rad
);

  localparam [1:0] ST_IDLE = 2'd0;
  localparam [1:0] ST_RUN  = 2'd1;
  localparam [1:0] ST_DONE = 2'd2;

  reg [1:0] state, next_state;
  reg [2:0] cycle;

  always @* begin
    next_state = state;
    op_we      = 1'b0;
    op_wad     = 2'd0;
    op_rad     = 2'd0;
    case (state)
      ST_IDLE: if (start) next_state = ST_RUN;
      ST_RUN:  begin
        op_we  = 1'b1;
        op_wad = 2'd1;
        op_rad = 2'd1;
        if (cycle == 3'd3) next_state = ST_DONE;
      end
      ST_DONE: next_state = ST_IDLE;
      default: next_state = ST_IDLE;
    endcase
  end

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state <= ST_IDLE;
      cycle <= 3'd0;
      busy  <= 1'b0;
    end
    else begin
      state <= next_state;
      busy  <= (state == ST_RUN);
      if (state != ST_RUN) cycle <= 3'd0;
      else                cycle <= cycle + 3'd1;
    end
  end

endmodule
