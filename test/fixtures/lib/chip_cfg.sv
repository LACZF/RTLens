// Shared constants and types, imported by the modules that use them.
package chip_cfg;

  // An imported constant: `import chip_cfg::TAPS;` makes TAPS visible in the
  // importing module without declaring it there.
  parameter int TAPS = 4;

  // An imported type, used as a port and a variable type.
  typedef logic [7:0] byte_t;

  function automatic int clamp8(input int value);
    return (value < 0) ? 0 : ((value > 255) ? 255 : value);
  endfunction

endpackage
