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
      uvm_component::report_static(1);
      uvm_component::run_static();
      uvm_queue#(int)::push(1);
      this.init();
    endtask

    local task drive_one();
      drives++;
    endtask
  endclass

  class my_rm extends uvm_component;
    protected bit [7:0] expected;
    protected int unsigned observations;

    function new(string name = "my_rm");
      super.new(name);
    endfunction

    virtual function void build_phase(int phase);
      super.build_phase(phase);
      this.reset();
    endfunction

    virtual function void write_item(my_item item);
      this.predict(item.payload);
      this.check(item.payload);
    endfunction

    function void predict(bit [7:0] payload);
      expected = payload;
      observations++;
    endfunction

    function void check(bit [7:0] payload);
      if (payload != expected) begin
        this.report_error();
      end
    endfunction

    function void reset();
      expected = 0;
      observations = 0;
    endfunction

    protected function void report_error();
      observations++;
    endfunction
  endclass

  class my_env extends uvm_env;
    my_driver drv;
    my_rm rm;

    function new(string name = "my_env");
      super.new(name);
    endfunction

    protected function void build_phase(int phase);
      super.build_phase(phase);
      this.build_driver();
      this.build_rm();
    endfunction

    protected function void build_driver();
      this.drv = new("drv");
    endfunction

    protected function void build_rm();
      this.rm = new("rm");
      this.rm.reset();
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
      this.configure_test();
    endfunction

    virtual task run_phase(int phase);
      errors = 0;
      this.check_env();
      this.finish_test();
    endtask

    local function void check_env();
      if (this.env == null) begin
        errors++;
      end
    endfunction

    local function void configure_test();
      errors = 0;
      this.check_env();
    endfunction

    local function void finish_test();
      if (errors > 0) begin
        this.check_env();
      end
    endfunction
  endclass

endpackage
