// A small UVM test case used by the class/method resolution tests.
package my_test_pkg;
  import uvm_base_pkg::*;

  class my_item extends uvm_sequence_item;
    rand bit [7:0] payload;
    randc bit [3:0] tag;

    function new(string name = "my_item");
      super.new(name);
    endfunction

    virtual function string convert2string();
      return "my_item";
    endfunction
  endclass

  class my_driver extends uvm_driver;
    protected int unsigned drives;

    function new(string name = "my_driver");
      super.new(name);
    endfunction

    virtual task run_phase(int phase);
      this.drive_one();
    endtask

    local task drive_one();
      drives++;
    endtask
  endclass

  class my_env extends uvm_env;
    my_driver drv;

    function new(string name = "my_env");
      super.new(name);
    endfunction

    protected function void build_phase(int phase);
      super.build_phase(phase);
      this.drv = new("drv");
    endfunction
  endclass

  class my_test extends uvm_test;
    my_env env;
    local int unsigned errors;

    function new(string name = "my_test");
      super.new(name);
    endfunction

    virtual function void build_phase(int phase);
      super.build_phase(phase);
      this.env = new("env");
      this.check_env();
    endfunction

    virtual task run_phase(int phase);
      errors = 0;
    endtask

    local function void check_env();
      if (this.env == null) begin
        errors++;
      end
    endfunction
  endclass

endpackage
